package api

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	"github.com/Z-M-Huang/openhive/internal/domain"
	mockOC "github.com/Z-M-Huang/openhive/internal/mocks/OrgChart"
	mockGO "github.com/Z-M-Huang/openhive/internal/mocks/GoOrchestrator"
)

func newTeamsTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
}

func sampleTeam() *domain.Team {
	return &domain.Team{
		TID:       "tid-alpha-00000001",
		Slug:      "alpha",
		LeaderAID: "aid-lead-00000001",
		Agents: []domain.Agent{
			{AID: "aid-agent-00000001", Name: "Agent One"},
		},
	}
}

func sampleOrgChart() map[string]*domain.Team {
	return map[string]*domain.Team{
		"alpha": sampleTeam(),
	}
}

// serveWithChi wraps a handler with chi router to support URL params
func serveWithChi(method, path, routePattern string, handler http.HandlerFunc) *httptest.ResponseRecorder {
	r := chi.NewRouter()
	r.MethodFunc(method, routePattern, handler)
	req := httptest.NewRequest(method, path, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func serveWithChiBody(method, path, routePattern string, handler http.HandlerFunc, body string) *httptest.ResponseRecorder {
	r := chi.NewRouter()
	r.MethodFunc(method, routePattern, handler)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestGetTeams_ReturnsOrgChart(t *testing.T) {
	oc := mockOC.NewMockOrgChart(t)
	oc.On("GetOrgChart").Return(sampleOrgChart())

	handler := GetTeamsHandler(oc, nil, newTeamsTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/teams", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var envelope successResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope))
	require.NotNil(t, envelope.Data)
	oc.AssertExpectations(t)
}

func TestGetTeams_EmptyOrgChart(t *testing.T) {
	oc := mockOC.NewMockOrgChart(t)
	oc.On("GetOrgChart").Return(map[string]*domain.Team{})

	handler := GetTeamsHandler(oc, nil, newTeamsTestLogger())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/teams", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGetTeamBySlug_ReturnsTeam(t *testing.T) {
	oc := mockOC.NewMockOrgChart(t)
	oc.On("GetTeamBySlug", "alpha").Return(sampleTeam(), nil)

	handler := GetTeamHandler(oc, nil, newTeamsTestLogger())
	w := serveWithChi(http.MethodGet, "/api/v1/teams/alpha", "/api/v1/teams/{slug}", handler)

	assert.Equal(t, http.StatusOK, w.Code)

	var envelope successResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope))
	require.NotNil(t, envelope.Data)
	oc.AssertExpectations(t)
}

func TestGetTeamBySlug_NotFound(t *testing.T) {
	oc := mockOC.NewMockOrgChart(t)
	oc.On("GetTeamBySlug", "nonexistent").Return(nil, &domain.NotFoundError{Resource: "team", ID: "nonexistent"})

	handler := GetTeamHandler(oc, nil, newTeamsTestLogger())
	w := serveWithChi(http.MethodGet, "/api/v1/teams/nonexistent", "/api/v1/teams/{slug}", handler)

	assert.Equal(t, http.StatusNotFound, w.Code)
	oc.AssertExpectations(t)
}

func TestCreateTeam_Success(t *testing.T) {
	orch := mockGO.NewMockGoOrchestrator(t)
	orch.On("CreateTeam", mock.Anything, "newteam", "aid-lead-00000002").Return(sampleTeam(), nil)

	handler := CreateTeamHandler(orch, newTeamsTestLogger())
	body := `{"slug":"newteam","leader_aid":"aid-lead-00000002"}`
	w := serveWithChiBody(http.MethodPost, "/api/v1/teams", "/api/v1/teams", handler, body)

	assert.Equal(t, http.StatusCreated, w.Code)
	orch.AssertExpectations(t)
}

func TestCreateTeam_MissingSlug(t *testing.T) {
	orch := mockGO.NewMockGoOrchestrator(t)

	handler := CreateTeamHandler(orch, newTeamsTestLogger())
	body := `{"leader_aid":"aid-lead-00000002"}`
	w := serveWithChiBody(http.MethodPost, "/api/v1/teams", "/api/v1/teams", handler, body)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "slug is required")
}

func TestCreateTeam_InvalidSlug(t *testing.T) {
	orch := mockGO.NewMockGoOrchestrator(t)

	handler := CreateTeamHandler(orch, newTeamsTestLogger())
	// Slug with spaces is invalid
	body := `{"slug":"invalid slug","leader_aid":"aid-lead-00000002"}`
	w := serveWithChiBody(http.MethodPost, "/api/v1/teams", "/api/v1/teams", handler, body)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestCreateTeam_RejectsReservedSlug(t *testing.T) {
	orch := mockGO.NewMockGoOrchestrator(t)

	handler := CreateTeamHandler(orch, newTeamsTestLogger())

	reservedSlugs := []string{"main", "admin", "system", "root", "openhive"}
	for _, slug := range reservedSlugs {
		t.Run(slug, func(t *testing.T) {
			body := `{"slug":"` + slug + `","leader_aid":"aid-lead-00000002"}`
			w := serveWithChiBody(http.MethodPost, "/api/v1/teams", "/api/v1/teams", handler, body)
			assert.Equal(t, http.StatusBadRequest, w.Code)
			assert.Contains(t, w.Body.String(), "reserved")
		})
	}
}

func TestCreateTeam_RejectsNonJSON(t *testing.T) {
	orch := mockGO.NewMockGoOrchestrator(t)

	handler := CreateTeamHandler(orch, newTeamsTestLogger())
	r := chi.NewRouter()
	r.Post("/api/v1/teams", handler)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/teams", strings.NewReader(`{"slug":"test","leader_aid":"aid-lead-00000002"}`))
	req.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnsupportedMediaType, w.Code)
}

func TestDeleteTeam_Success(t *testing.T) {
	orch := mockGO.NewMockGoOrchestrator(t)
	orch.On("DeleteTeam", mock.Anything, "alpha").Return(nil)

	handler := DeleteTeamHandler(orch, newTeamsTestLogger())
	w := serveWithChi(http.MethodDelete, "/api/v1/teams/alpha", "/api/v1/teams/{slug}", handler)

	assert.Equal(t, http.StatusNoContent, w.Code)
	orch.AssertExpectations(t)
}

func TestDeleteTeam_NotFound(t *testing.T) {
	orch := mockGO.NewMockGoOrchestrator(t)
	orch.On("DeleteTeam", mock.Anything, "ghost").Return(&domain.NotFoundError{Resource: "team", ID: "ghost"})

	handler := DeleteTeamHandler(orch, newTeamsTestLogger())
	w := serveWithChi(http.MethodDelete, "/api/v1/teams/ghost", "/api/v1/teams/{slug}", handler)

	assert.Equal(t, http.StatusNotFound, w.Code)
	orch.AssertExpectations(t)
}
