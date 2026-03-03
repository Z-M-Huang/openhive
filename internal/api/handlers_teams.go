package api

import (
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// teamResponse is the API representation of a team, including heartbeat status.
type teamResponse struct {
	Slug           string                    `json:"slug"`
	TID            string                    `json:"tid"`
	LeaderAID      string                    `json:"leader_aid"`
	ParentSlug     string                    `json:"parent_slug,omitempty"`
	Children       []string                  `json:"children,omitempty"`
	Agents         []domain.Agent            `json:"agents,omitempty"`
	Heartbeat      *domain.HeartbeatStatus   `json:"heartbeat,omitempty"`
}

func buildTeamResponse(team *domain.Team, hbm domain.HeartbeatMonitor) teamResponse {
	resp := teamResponse{
		Slug:       team.Slug,
		TID:        team.TID,
		LeaderAID:  team.LeaderAID,
		ParentSlug: team.ParentSlug,
		Children:   team.Children,
		Agents:     team.Agents,
	}
	if hbm != nil {
		if status, err := hbm.GetStatus(team.TID); err == nil {
			resp.Heartbeat = status
		}
	}
	return resp
}

// GetTeamsHandler returns a handler for GET /api/v1/teams.
func GetTeamsHandler(orgChart domain.OrgChart, hbm domain.HeartbeatMonitor, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		teamsMap := orgChart.GetOrgChart()

		result := make([]teamResponse, 0, len(teamsMap))
		for _, team := range teamsMap {
			result = append(result, buildTeamResponse(team, hbm))
		}

		JSON(w, http.StatusOK, result)
	}
}

// GetTeamHandler returns a handler for GET /api/v1/teams/{slug}.
func GetTeamHandler(orgChart domain.OrgChart, hbm domain.HeartbeatMonitor, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		slug := chi.URLParam(r, "slug")
		if slug == "" {
			Error(w, http.StatusBadRequest, "INVALID_PARAM", "slug is required")
			return
		}

		team, err := orgChart.GetTeamBySlug(slug)
		if err != nil {
			MapDomainError(w, err)
			return
		}

		JSON(w, http.StatusOK, buildTeamResponse(team, hbm))
	}
}

// createTeamRequest is the request body for POST /api/v1/teams.
type createTeamRequest struct {
	Slug      string `json:"slug"`
	LeaderAID string `json:"leader_aid"`
}

// CreateTeamHandler returns a handler for POST /api/v1/teams.
func CreateTeamHandler(orch domain.GoOrchestrator, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createTeamRequest
		if !requireJSONBody(w, r, &req) {
			return
		}

		if req.Slug == "" {
			Error(w, http.StatusBadRequest, "VALIDATION_ERROR", "slug is required")
			return
		}
		if req.LeaderAID == "" {
			Error(w, http.StatusBadRequest, "VALIDATION_ERROR", "leader_aid is required")
			return
		}
		if err := domain.ValidateSlug(req.Slug); err != nil {
			MapDomainError(w, err)
			return
		}
		if domain.IsReservedSlug(req.Slug) {
			Error(w, http.StatusBadRequest, "VALIDATION_ERROR", fmt.Sprintf("slug %q is reserved and cannot be used as a team name", req.Slug))
			return
		}

		team, err := orch.CreateTeam(r.Context(), req.Slug, req.LeaderAID)
		if err != nil {
			logger.Error("failed to create team", "slug", req.Slug, "error", err)
			MapDomainError(w, err)
			return
		}

		JSON(w, http.StatusCreated, team)
	}
}

// DeleteTeamHandler returns a handler for DELETE /api/v1/teams/{slug}.
func DeleteTeamHandler(orch domain.GoOrchestrator, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		slug := chi.URLParam(r, "slug")
		if slug == "" {
			Error(w, http.StatusBadRequest, "INVALID_PARAM", "slug is required")
			return
		}

		if err := orch.DeleteTeam(r.Context(), slug); err != nil {
			logger.Error("failed to delete team", "slug", slug, "error", err)
			MapDomainError(w, err)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
