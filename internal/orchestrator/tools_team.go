package orchestrator

import (
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/google/uuid"
)

// TeamToolsDeps holds dependencies for team management tool handlers.
type TeamToolsDeps struct {
	ConfigLoader domain.ConfigLoader
	OrgChart     domain.OrgChart
	EventBus     domain.EventBus
	KeyManager   domain.KeyManager
	Logger       *slog.Logger
}

// RegisterTeamTools registers all team management SDK tool handlers on the ToolHandler.
func RegisterTeamTools(handler *ToolHandler, deps TeamToolsDeps) {
	handler.Register("create_agent", makeCreateAgent(deps))
	handler.Register("create_team", makeCreateTeam(deps))
	handler.Register("delete_team", makeDeleteTeam(deps))
	handler.Register("delete_agent", makeDeleteAgent(deps))
	handler.Register("list_teams", makeListTeams(deps))
	handler.Register("get_team", makeGetTeam(deps))
	handler.Register("update_team", makeUpdateTeam(deps))
}

// --- create_agent ---

type createAgentArgs struct {
	Name      string `json:"name"`
	RoleFile  string `json:"role_file"`
	ModelTier string `json:"model_tier,omitempty"`
	Provider  string `json:"provider,omitempty"`
	TeamSlug  string `json:"team_slug"` // parent team to add agent to (use "master" for top-level)
}

func makeCreateAgent(deps TeamToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a createAgentArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if a.Name == "" {
			return nil, &domain.ValidationError{Field: "name", Message: "name is required"}
		}
		if a.RoleFile == "" {
			return nil, &domain.ValidationError{Field: "role_file", Message: "role_file is required"}
		}
		if a.TeamSlug == "" {
			return nil, &domain.ValidationError{Field: "team_slug", Message: "team_slug is required"}
		}
		if a.ModelTier != "" {
			if _, err := domain.ParseModelTier(a.ModelTier); err != nil {
				return nil, &domain.ValidationError{Field: "model_tier", Message: fmt.Sprintf("invalid model_tier: %s", a.ModelTier)}
			}
		}

		// Generate a unique AID
		shortID := uuid.NewString()[:8]
		nameSlug := slugifyName(a.Name)
		aid := fmt.Sprintf("aid-%s-%s", nameSlug, shortID)

		agent := domain.Agent{
			AID:       aid,
			Name:      a.Name,
			RoleFile:  a.RoleFile,
			Provider:  a.Provider,
			ModelTier: a.ModelTier,
		}

		if a.TeamSlug == "master" {
			// Add to master config agents list
			master, err := deps.ConfigLoader.LoadMaster()
			if err != nil {
				return nil, fmt.Errorf("failed to load master config: %w", err)
			}
			// Check for duplicate AID (should not happen with UUID, but guard)
			for _, existing := range master.Agents {
				if existing.AID == aid {
					return nil, &domain.ConflictError{Resource: "agent", Message: "duplicate AID"}
				}
			}
			master.Agents = append(master.Agents, agent)
			if err := deps.ConfigLoader.SaveMaster(master); err != nil {
				return nil, fmt.Errorf("failed to save master config: %w", err)
			}
			// Rebuild OrgChart
			if err := rebuildOrgChart(deps); err != nil {
				deps.Logger.Warn("failed to rebuild orgchart after create_agent", "error", err)
			}
		} else {
			// Validate slug
			if err := domain.ValidateSlug(a.TeamSlug); err != nil {
				return nil, err
			}
			// Add to team config
			team, err := deps.ConfigLoader.LoadTeam(a.TeamSlug)
			if err != nil {
				return nil, fmt.Errorf("failed to load team %s: %w", a.TeamSlug, err)
			}
			// Check for duplicate AID
			for _, existing := range team.Agents {
				if existing.AID == aid {
					return nil, &domain.ConflictError{Resource: "agent", Message: "duplicate AID"}
				}
			}
			team.Agents = append(team.Agents, agent)
			if err := deps.ConfigLoader.SaveTeam(a.TeamSlug, team); err != nil {
				return nil, fmt.Errorf("failed to save team config: %w", err)
			}
			// Rebuild OrgChart
			if err := rebuildOrgChart(deps); err != nil {
				deps.Logger.Warn("failed to rebuild orgchart after create_agent", "error", err)
			}
		}

		deps.Logger.Info("agent created", "aid", aid, "name", a.Name, "team_slug", a.TeamSlug)

		return json.Marshal(map[string]string{"aid": aid, "status": "created"})
	}
}

// slugifyName converts a display name to a short slug segment safe for use in an AID.
func slugifyName(name string) string {
	result := make([]byte, 0, len(name))
	for _, c := range []byte(name) {
		switch {
		case c >= 'a' && c <= 'z':
			result = append(result, c)
		case c >= 'A' && c <= 'Z':
			result = append(result, c+32)
		case c >= '0' && c <= '9':
			result = append(result, c)
		case c == ' ' || c == '-' || c == '_':
			if len(result) > 0 && result[len(result)-1] != '-' {
				result = append(result, '-')
			}
		}
	}
	// Trim trailing hyphen
	for len(result) > 0 && result[len(result)-1] == '-' {
		result = result[:len(result)-1]
	}
	if len(result) == 0 {
		return "agent"
	}
	if len(result) > 16 {
		result = result[:16]
	}
	return string(result)
}

// --- create_team ---

type createTeamArgs struct {
	Slug       string `json:"slug"`
	LeaderAID  string `json:"leader_aid"`
	ParentSlug string `json:"parent_slug,omitempty"`
}

func makeCreateTeam(deps TeamToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a createTeamArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if err := domain.ValidateSlug(a.Slug); err != nil {
			return nil, err
		}
		if a.LeaderAID == "" {
			return nil, &domain.ValidationError{Field: "leader_aid", Message: "leader_aid is required"}
		}
		if err := domain.ValidateAID(a.LeaderAID); err != nil {
			return nil, err
		}

		// Verify leader_aid exists
		if _, err := deps.OrgChart.GetAgentByAID(a.LeaderAID); err != nil {
			return nil, &domain.ValidationError{Field: "leader_aid", Message: fmt.Sprintf("agent %s does not exist", a.LeaderAID)}
		}

		// Check duplicate slug
		existingTeams, err := deps.ConfigLoader.ListTeams()
		if err != nil {
			return nil, fmt.Errorf("failed to list teams: %w", err)
		}
		for _, slug := range existingTeams {
			if slug == a.Slug {
				return nil, &domain.ConflictError{Resource: "team", Message: fmt.Sprintf("team %s already exists", a.Slug)}
			}
		}

		// Generate TID
		shortID := uuid.NewString()[:8]
		tid := fmt.Sprintf("tid-%s-%s", a.Slug[:min(8, len(a.Slug))], shortID)

		team := &domain.Team{
			TID:        tid,
			Slug:       a.Slug,
			LeaderAID:  a.LeaderAID,
			ParentSlug: a.ParentSlug,
		}

		// Create team directory and save config
		if err := deps.ConfigLoader.CreateTeamDir(a.Slug); err != nil {
			return nil, fmt.Errorf("failed to create team directory: %w", err)
		}
		if err := deps.ConfigLoader.SaveTeam(a.Slug, team); err != nil {
			return nil, fmt.Errorf("failed to save team config: %w", err)
		}

		// Update leader agent's LeadsTeam field if it's in a team config
		if err := updateAgentLeadsTeam(deps, a.LeaderAID, a.Slug); err != nil {
			deps.Logger.Warn("failed to update leader agent leads_team", "error", err, "leader_aid", a.LeaderAID)
		}

		// Rebuild OrgChart
		if err := rebuildOrgChart(deps); err != nil {
			deps.Logger.Warn("failed to rebuild orgchart after create_team", "error", err)
		}

		// Publish event
		if deps.EventBus != nil {
			deps.EventBus.Publish(domain.Event{
				Type:    domain.EventTypeTeamCreated,
				Payload: team,
			})
		}

		deps.Logger.Info("team created", "slug", a.Slug, "tid", tid, "leader_aid", a.LeaderAID)

		return json.Marshal(map[string]string{"tid": tid, "slug": a.Slug, "status": "created"})
	}
}

// min returns the smaller of two ints.
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// updateAgentLeadsTeam sets the LeadsTeam field on the leader agent's config entry.
func updateAgentLeadsTeam(deps TeamToolsDeps, leaderAID, teamSlug string) error {
	// Check master config first
	master, err := deps.ConfigLoader.LoadMaster()
	if err != nil {
		return fmt.Errorf("failed to load master config: %w", err)
	}
	for i, agent := range master.Agents {
		if agent.AID == leaderAID {
			master.Agents[i].LeadsTeam = teamSlug
			return deps.ConfigLoader.SaveMaster(master)
		}
	}

	// Check all teams
	slugs, err := deps.ConfigLoader.ListTeams()
	if err != nil {
		return fmt.Errorf("failed to list teams: %w", err)
	}
	for _, slug := range slugs {
		team, err := deps.ConfigLoader.LoadTeam(slug)
		if err != nil {
			continue
		}
		for i, agent := range team.Agents {
			if agent.AID == leaderAID {
				team.Agents[i].LeadsTeam = teamSlug
				return deps.ConfigLoader.SaveTeam(slug, team)
			}
		}
	}
	return nil
}

// --- delete_team ---

type deleteTeamArgs struct {
	Slug string `json:"slug"`
}

func makeDeleteTeam(deps TeamToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a deleteTeamArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if err := domain.ValidateSlug(a.Slug); err != nil {
			return nil, err
		}

		// Verify team exists
		if _, err := deps.OrgChart.GetTeamBySlug(a.Slug); err != nil {
			return nil, &domain.NotFoundError{Resource: "team", ID: a.Slug}
		}

		// Delete team directory
		if err := deps.ConfigLoader.DeleteTeamDir(a.Slug); err != nil {
			return nil, fmt.Errorf("failed to delete team directory: %w", err)
		}

		// Rebuild OrgChart
		if err := rebuildOrgChart(deps); err != nil {
			deps.Logger.Warn("failed to rebuild orgchart after delete_team", "error", err)
		}

		// Publish event
		if deps.EventBus != nil {
			deps.EventBus.Publish(domain.Event{
				Type:    domain.EventTypeTeamDeleted,
				Payload: map[string]string{"slug": a.Slug},
			})
		}

		deps.Logger.Info("team deleted", "slug", a.Slug)

		return json.Marshal(map[string]string{"status": "deleted", "slug": a.Slug})
	}
}

// --- delete_agent ---

type deleteAgentArgs struct {
	AID      string `json:"aid"`
	TeamSlug string `json:"team_slug"` // "master" for top-level agents
}

func makeDeleteAgent(deps TeamToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a deleteAgentArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if err := domain.ValidateAID(a.AID); err != nil {
			return nil, err
		}
		if a.TeamSlug == "" {
			return nil, &domain.ValidationError{Field: "team_slug", Message: "team_slug is required"}
		}

		// Check if agent leads a team (cascade warning)
		leadTeams, _ := deps.OrgChart.GetLeadTeams(a.AID)
		if len(leadTeams) > 0 {
			return nil, &domain.ValidationError{
				Field:   "aid",
				Message: fmt.Sprintf("agent %s leads team(s) %v — delete the team(s) first", a.AID, leadTeams),
			}
		}

		if a.TeamSlug == "master" {
			master, err := deps.ConfigLoader.LoadMaster()
			if err != nil {
				return nil, fmt.Errorf("failed to load master config: %w", err)
			}
			newAgents := make([]domain.Agent, 0, len(master.Agents))
			found := false
			for _, agent := range master.Agents {
				if agent.AID == a.AID {
					found = true
					continue
				}
				newAgents = append(newAgents, agent)
			}
			if !found {
				return nil, &domain.NotFoundError{Resource: "agent", ID: a.AID}
			}
			master.Agents = newAgents
			if err := deps.ConfigLoader.SaveMaster(master); err != nil {
				return nil, fmt.Errorf("failed to save master config: %w", err)
			}
		} else {
			if err := domain.ValidateSlug(a.TeamSlug); err != nil {
				return nil, err
			}
			team, err := deps.ConfigLoader.LoadTeam(a.TeamSlug)
			if err != nil {
				return nil, fmt.Errorf("failed to load team %s: %w", a.TeamSlug, err)
			}
			newAgents := make([]domain.Agent, 0, len(team.Agents))
			found := false
			for _, agent := range team.Agents {
				if agent.AID == a.AID {
					found = true
					continue
				}
				newAgents = append(newAgents, agent)
			}
			if !found {
				return nil, &domain.NotFoundError{Resource: "agent", ID: a.AID}
			}
			team.Agents = newAgents
			if err := deps.ConfigLoader.SaveTeam(a.TeamSlug, team); err != nil {
				return nil, fmt.Errorf("failed to save team config: %w", err)
			}
		}

		// Rebuild OrgChart
		if err := rebuildOrgChart(deps); err != nil {
			deps.Logger.Warn("failed to rebuild orgchart after delete_agent", "error", err)
		}

		deps.Logger.Info("agent deleted", "aid", a.AID, "team_slug", a.TeamSlug)

		return json.Marshal(map[string]string{"status": "deleted", "aid": a.AID})
	}
}

// --- list_teams ---

func makeListTeams(deps TeamToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		teams := deps.OrgChart.GetOrgChart()
		return json.Marshal(teams)
	}
}

// --- get_team ---

type getTeamArgs struct {
	Slug string `json:"slug"`
}

func makeGetTeam(deps TeamToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a getTeamArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if err := domain.ValidateSlug(a.Slug); err != nil {
			return nil, err
		}

		team, err := deps.ConfigLoader.LoadTeam(a.Slug)
		if err != nil {
			return nil, err
		}

		return json.Marshal(team)
	}
}

// --- update_team ---

type updateTeamArgs struct {
	Slug  string `json:"slug"`
	Field string `json:"field"`
	Value interface{} `json:"value"`
}

// allowedTeamFields defines the whitelist of fields that can be updated via update_team.
var allowedTeamFields = map[string]bool{
	"env_vars":         true,
	"container_config": true,
}

func makeUpdateTeam(deps TeamToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a updateTeamArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if err := domain.ValidateSlug(a.Slug); err != nil {
			return nil, err
		}
		if a.Field == "" {
			return nil, &domain.ValidationError{Field: "field", Message: "field is required"}
		}
		if !allowedTeamFields[a.Field] {
			return nil, &domain.ValidationError{
				Field:   "field",
				Message: fmt.Sprintf("field %q is not updatable; allowed: env_vars, container_config", a.Field),
			}
		}

		team, err := deps.ConfigLoader.LoadTeam(a.Slug)
		if err != nil {
			return nil, err
		}

		// Apply update by re-marshaling the value into the field
		valueBytes, err := json.Marshal(a.Value)
		if err != nil {
			return nil, &domain.ValidationError{Field: "value", Message: "value cannot be marshaled to JSON"}
		}

		switch a.Field {
		case "env_vars":
			var envVars map[string]string
			if err := json.Unmarshal(valueBytes, &envVars); err != nil {
				return nil, &domain.ValidationError{Field: "value", Message: "env_vars must be a string map"}
			}
			team.EnvVars = envVars
		case "container_config":
			var cc domain.ContainerConfig
			if err := json.Unmarshal(valueBytes, &cc); err != nil {
				return nil, &domain.ValidationError{Field: "value", Message: "container_config must be a ContainerConfig object"}
			}
			team.ContainerConfig = cc
		}

		if err := deps.ConfigLoader.SaveTeam(a.Slug, team); err != nil {
			return nil, fmt.Errorf("failed to save team config: %w", err)
		}

		deps.Logger.Info("team updated", "slug", a.Slug, "field", a.Field)

		return json.Marshal(map[string]string{"status": "updated", "slug": a.Slug, "field": a.Field})
	}
}

// rebuildOrgChart loads the current state of all configs and rebuilds the org chart.
func rebuildOrgChart(deps TeamToolsDeps) error {
	master := deps.ConfigLoader.GetMaster()
	if master == nil {
		var err error
		master, err = deps.ConfigLoader.LoadMaster()
		if err != nil {
			return fmt.Errorf("failed to load master config for orgchart rebuild: %w", err)
		}
	}

	slugs, err := deps.ConfigLoader.ListTeams()
	if err != nil {
		return fmt.Errorf("failed to list teams for orgchart rebuild: %w", err)
	}

	teams := make(map[string]*domain.Team, len(slugs))
	for _, slug := range slugs {
		team, err := deps.ConfigLoader.LoadTeam(slug)
		if err != nil {
			deps.Logger.Warn("failed to load team during orgchart rebuild", "slug", slug, "error", err)
			continue
		}
		teams[slug] = team
	}

	return deps.OrgChart.RebuildFromConfig(master, teams)
}
