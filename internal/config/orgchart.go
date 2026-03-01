package config

import (
	"sync"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// OrgChartService implements the domain.OrgChart interface.
// It maintains an in-memory cache of the agent/team hierarchy
// built from all config files.
type OrgChartService struct {
	teams      map[string]*domain.Team   // keyed by slug
	agents     map[string]*domain.Agent  // keyed by AID
	agentTeam  map[string]string         // AID -> team slug
	leadTeams  map[string][]string       // AID -> team slugs led
	mu         sync.RWMutex
}

// NewOrgChart creates a new OrgChart service.
func NewOrgChart() *OrgChartService {
	return &OrgChartService{
		teams:     make(map[string]*domain.Team),
		agents:    make(map[string]*domain.Agent),
		agentTeam: make(map[string]string),
		leadTeams: make(map[string][]string),
	}
}

// RebuildFromConfig rebuilds the OrgChart cache from master config and team configs.
func (o *OrgChartService) RebuildFromConfig(master *domain.MasterConfig, teams map[string]*domain.Team) error {
	o.mu.Lock()
	defer o.mu.Unlock()

	// Reset maps
	o.teams = make(map[string]*domain.Team)
	o.agents = make(map[string]*domain.Agent)
	o.agentTeam = make(map[string]string)
	o.leadTeams = make(map[string][]string)

	// Track all AIDs for uniqueness check
	allAIDs := make(map[string]string) // AID -> source (team slug or "master")

	// Add main assistant
	if master.Assistant.AID != "" {
		agent := &domain.Agent{
			AID:            master.Assistant.AID,
			Name:           master.Assistant.Name,
			Provider:       master.Assistant.Provider,
			ModelTier:      master.Assistant.ModelTier,
			MaxTurns:       master.Assistant.MaxTurns,
			TimeoutMinutes: master.Assistant.TimeoutMinutes,
		}
		o.agents[agent.AID] = agent
		allAIDs[agent.AID] = "master"
	}

	// Add top-level team lead agents from master config
	for i := range master.Agents {
		agent := &master.Agents[i]
		if _, exists := allAIDs[agent.AID]; exists {
			return &domain.ConflictError{
				Resource: "agent",
				Message:  "duplicate AID " + agent.AID + " in master config",
			}
		}
		o.agents[agent.AID] = agent
		allAIDs[agent.AID] = "master"
	}

	// Process teams
	for slug, team := range teams {
		team.Slug = slug
		o.teams[slug] = team

		// Register leader
		if team.LeaderAID != "" {
			o.leadTeams[team.LeaderAID] = append(o.leadTeams[team.LeaderAID], slug)
		}

		// Register team agents
		for i := range team.Agents {
			agent := &team.Agents[i]
			if existingSource, exists := allAIDs[agent.AID]; exists {
				return &domain.ConflictError{
					Resource: "agent",
					Message:  "duplicate AID " + agent.AID + " (in " + slug + " and " + existingSource + ")",
				}
			}
			o.agents[agent.AID] = agent
			o.agentTeam[agent.AID] = slug
			allAIDs[agent.AID] = slug
		}
	}

	// Validate: check for circular parents
	for slug, team := range o.teams {
		if err := o.detectCircularParent(slug, team.ParentSlug); err != nil {
			return err
		}
	}

	return nil
}

func (o *OrgChartService) detectCircularParent(startSlug, parentSlug string) error {
	visited := map[string]bool{startSlug: true}
	current := parentSlug
	for current != "" {
		if visited[current] {
			return &domain.ValidationError{
				Field:   "parent_slug",
				Message: "circular parent chain detected involving " + startSlug,
			}
		}
		visited[current] = true
		team, exists := o.teams[current]
		if !exists {
			break
		}
		current = team.ParentSlug
	}
	return nil
}

// GetOrgChart returns all teams in the hierarchy.
func (o *OrgChartService) GetOrgChart() map[string]*domain.Team {
	o.mu.RLock()
	defer o.mu.RUnlock()
	result := make(map[string]*domain.Team, len(o.teams))
	for k, v := range o.teams {
		result[k] = v
	}
	return result
}

// GetAgentByAID returns an agent by its AID.
func (o *OrgChartService) GetAgentByAID(aid string) (*domain.Agent, error) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	agent, exists := o.agents[aid]
	if !exists {
		return nil, &domain.NotFoundError{Resource: "agent", ID: aid}
	}
	return agent, nil
}

// GetTeamBySlug returns a team by its slug.
func (o *OrgChartService) GetTeamBySlug(slug string) (*domain.Team, error) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	team, exists := o.teams[slug]
	if !exists {
		return nil, &domain.NotFoundError{Resource: "team", ID: slug}
	}
	return team, nil
}

// GetTeamForAgent returns the team an agent belongs to.
func (o *OrgChartService) GetTeamForAgent(aid string) (*domain.Team, error) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	slug, exists := o.agentTeam[aid]
	if !exists {
		return nil, &domain.NotFoundError{Resource: "team for agent", ID: aid}
	}
	team, exists := o.teams[slug]
	if !exists {
		return nil, &domain.NotFoundError{Resource: "team", ID: slug}
	}
	return team, nil
}

// GetLeadTeams returns the team slugs that an agent leads.
func (o *OrgChartService) GetLeadTeams(aid string) ([]string, error) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	slugs, exists := o.leadTeams[aid]
	if !exists {
		return nil, nil
	}
	result := make([]string, len(slugs))
	copy(result, slugs)
	return result, nil
}

// GetSubordinates returns agents that report to the given agent.
func (o *OrgChartService) GetSubordinates(aid string) ([]domain.Agent, error) {
	o.mu.RLock()
	defer o.mu.RUnlock()

	teamSlugs := o.leadTeams[aid]
	var subordinates []domain.Agent
	for _, slug := range teamSlugs {
		team, exists := o.teams[slug]
		if !exists {
			continue
		}
		subordinates = append(subordinates, team.Agents...)
	}
	return subordinates, nil
}

// GetSupervisor returns the lead agent of the team this agent belongs to.
func (o *OrgChartService) GetSupervisor(aid string) (*domain.Agent, error) {
	o.mu.RLock()
	defer o.mu.RUnlock()

	slug, exists := o.agentTeam[aid]
	if !exists {
		return nil, &domain.NotFoundError{Resource: "supervisor for agent", ID: aid}
	}
	team, exists := o.teams[slug]
	if !exists {
		return nil, &domain.NotFoundError{Resource: "team", ID: slug}
	}
	leader, exists := o.agents[team.LeaderAID]
	if !exists {
		return nil, &domain.NotFoundError{Resource: "leader agent", ID: team.LeaderAID}
	}
	return leader, nil
}
