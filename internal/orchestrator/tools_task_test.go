package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/config"
	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- in-memory mocks for task tests ---

type memTaskStore struct {
	tasks map[string]*domain.Task
}

func newMemTaskStore() *memTaskStore {
	return &memTaskStore{tasks: make(map[string]*domain.Task)}
}

func (m *memTaskStore) Create(_ context.Context, task *domain.Task) error {
	m.tasks[task.ID] = task
	return nil
}
func (m *memTaskStore) Get(_ context.Context, id string) (*domain.Task, error) {
	t, ok := m.tasks[id]
	if !ok {
		return nil, &domain.NotFoundError{Resource: "task", ID: id}
	}
	return t, nil
}
func (m *memTaskStore) Update(_ context.Context, task *domain.Task) error {
	m.tasks[task.ID] = task
	return nil
}
func (m *memTaskStore) Delete(_ context.Context, id string) error {
	delete(m.tasks, id)
	return nil
}
func (m *memTaskStore) ListByTeam(_ context.Context, teamSlug string) ([]*domain.Task, error) {
	var result []*domain.Task
	for _, t := range m.tasks {
		if t.TeamSlug == teamSlug {
			result = append(result, t)
		}
	}
	return result, nil
}
func (m *memTaskStore) ListByStatus(_ context.Context, status domain.TaskStatus) ([]*domain.Task, error) {
	var result []*domain.Task
	for _, t := range m.tasks {
		if t.Status == status {
			result = append(result, t)
		}
	}
	return result, nil
}
func (m *memTaskStore) GetSubtree(_ context.Context, rootID string) ([]*domain.Task, error) {
	var result []*domain.Task
	for _, t := range m.tasks {
		if t.ID == rootID || t.ParentID == rootID {
			result = append(result, t)
		}
	}
	return result, nil
}

// mockWSHubForTaskTools implements domain.WSHub for task tool tests.
type mockWSHubForTaskTools struct {
	sentMessages [][]byte
	sentTeam     string
}

func (m *mockWSHubForTaskTools) RegisterConnection(_ string, _ domain.WSConnection) error {
	return nil
}
func (m *mockWSHubForTaskTools) UnregisterConnection(_ string) {}
func (m *mockWSHubForTaskTools) SendToTeam(teamID string, msg []byte) error {
	m.sentTeam = teamID
	m.sentMessages = append(m.sentMessages, msg)
	return nil
}
func (m *mockWSHubForTaskTools) BroadcastAll(_ []byte) error        { return nil }
func (m *mockWSHubForTaskTools) GenerateToken(_ string) (string, error) {
	return "test-token-12345", nil
}
func (m *mockWSHubForTaskTools) HandleUpgrade(_ http.ResponseWriter, _ *http.Request) {}
func (m *mockWSHubForTaskTools) GetConnectedTeams() []string                          { return nil }
func (m *mockWSHubForTaskTools) SetOnMessage(_ func(string, []byte))                  {}
func (m *mockWSHubForTaskTools) SetOnConnect(_ func(string))                          {}

var _ domain.WSHub = (*mockWSHubForTaskTools)(nil)

// newTaskToolsDeps creates a TaskToolsDeps with an in-memory orgchart, task store, ws hub.
func newTaskToolsDeps(t *testing.T) (TaskToolsDeps, *memTaskStore, *mockWSHubForTaskTools, *config.OrgChartService) {
	t.Helper()
	store := newMemTaskStore()
	hub := &mockWSHubForTaskTools{}
	orgChart := config.NewOrgChart()

	return TaskToolsDeps{
		TaskStore: store,
		WSHub:     hub,
		OrgChart:  orgChart,
		Logger:    newTestLogger(t),
	}, store, hub, orgChart
}

// --- Tests ---

func TestDispatchSubtask_CreatesTaskAndSendsViaWS(t *testing.T) {
	deps, store, hub, orgChart := newTaskToolsDeps(t)

	// Seed orgchart: create a team with an agent
	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{AID: "aid-asst-main0001", Name: "Asst"},
		Agents:    []domain.Agent{{AID: "aid-lead-00000001", Name: "Lead"}},
	}
	teamA := &domain.Team{
		Slug:      "team-a",
		LeaderAID: "aid-lead-00000001",
		TID:       "tid-teama00000001",
		Agents:    []domain.Agent{{AID: "aid-dev-00000001", Name: "Dev"}},
	}
	require.NoError(t, orgChart.RebuildFromConfig(master, map[string]*domain.Team{"team-a": teamA}))

	handler := NewToolHandler(newTestLogger(t))
	RegisterTaskTools(handler, deps)

	args, _ := json.Marshal(map[string]string{
		"agent_aid": "aid-dev-00000001",
		"prompt":    "Write tests",
	})
	result, err := handler.HandleToolCall("c1", "dispatch_subtask", args)
	require.NoError(t, err)

	var resp map[string]string
	require.NoError(t, json.Unmarshal(result, &resp))
	assert.NotEmpty(t, resp["task_id"])

	// Verify task created in store
	assert.Len(t, store.tasks, 1)
	for _, task := range store.tasks {
		assert.Equal(t, "Write tests", task.Prompt)
		assert.Equal(t, "aid-dev-00000001", task.AgentAID)
	}

	// Verify WS message sent
	assert.Equal(t, "team-a", hub.sentTeam)
	assert.NotEmpty(t, hub.sentMessages)
}

func TestDispatchSubtask_ValidatesAgentAID(t *testing.T) {
	deps, _, _, _ := newTaskToolsDeps(t)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTaskTools(handler, deps)

	args, _ := json.Marshal(map[string]string{
		"agent_aid": "invalid-aid",
		"prompt":    "Do something",
	})
	_, err := handler.HandleToolCall("c1", "dispatch_subtask", args)
	require.Error(t, err)
}

func TestDispatchSubtask_RejectsUnknownAgent(t *testing.T) {
	deps, _, _, orgChart := newTaskToolsDeps(t)
	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{AID: "aid-asst-main0001", Name: "Asst"},
	}
	require.NoError(t, orgChart.RebuildFromConfig(master, nil))

	handler := NewToolHandler(newTestLogger(t))
	RegisterTaskTools(handler, deps)

	args, _ := json.Marshal(map[string]string{
		"agent_aid": "aid-unknown-00000001",
		"prompt":    "Do something",
	})
	_, err := handler.HandleToolCall("c1", "dispatch_subtask", args)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestGetTaskStatus_ReturnsTaskInfo(t *testing.T) {
	deps, store, _, _ := newTaskToolsDeps(t)
	now := time.Now()
	task := &domain.Task{
		ID:        "task-001",
		TeamSlug:  "team-a",
		AgentAID:  "aid-dev-00000001",
		Status:    domain.TaskStatusRunning,
		Prompt:    "Run analysis",
		CreatedAt: now,
		UpdatedAt: now,
	}
	store.tasks[task.ID] = task

	handler := NewToolHandler(newTestLogger(t))
	RegisterTaskTools(handler, deps)

	args, _ := json.Marshal(map[string]string{"task_id": "task-001"})
	result, err := handler.HandleToolCall("c1", "get_task_status", args)
	require.NoError(t, err)

	var returnedTask domain.Task
	require.NoError(t, json.Unmarshal(result, &returnedTask))
	assert.Equal(t, "task-001", returnedTask.ID)
	assert.Equal(t, domain.TaskStatusRunning, returnedTask.Status)
}

func TestGetTaskStatus_ReturnsNotFoundForMissing(t *testing.T) {
	deps, _, _, _ := newTaskToolsDeps(t)
	handler := NewToolHandler(newTestLogger(t))
	RegisterTaskTools(handler, deps)

	args, _ := json.Marshal(map[string]string{"task_id": "nonexistent"})
	_, err := handler.HandleToolCall("c1", "get_task_status", args)
	require.Error(t, err)
}

func TestCancelTask_UpdatesStatusAndSendsCancel(t *testing.T) {
	deps, store, hub, _ := newTaskToolsDeps(t)
	now := time.Now()
	task := &domain.Task{
		ID:        "task-cancel-001",
		TeamSlug:  "team-a",
		AgentAID:  "aid-dev-00000001",
		Status:    domain.TaskStatusRunning,
		Prompt:    "Long task",
		CreatedAt: now,
		UpdatedAt: now,
	}
	store.tasks[task.ID] = task

	handler := NewToolHandler(newTestLogger(t))
	RegisterTaskTools(handler, deps)

	args, _ := json.Marshal(map[string]string{"task_id": "task-cancel-001"})
	result, err := handler.HandleToolCall("c1", "cancel_task", args)
	require.NoError(t, err)

	var resp map[string]string
	require.NoError(t, json.Unmarshal(result, &resp))
	assert.Equal(t, "cancelled", resp["status"])

	// Verify task updated in store
	updatedTask := store.tasks["task-cancel-001"]
	assert.Equal(t, domain.TaskStatusCancelled, updatedTask.Status)
	assert.NotNil(t, updatedTask.CompletedAt)

	// Verify cancel message sent
	assert.NotEmpty(t, hub.sentMessages)
}

func TestCancelTask_VerifiesCallerAccess_AlreadyCompleted(t *testing.T) {
	deps, store, _, _ := newTaskToolsDeps(t)
	now := time.Now()
	completed := now
	task := &domain.Task{
		ID:          "task-done-001",
		TeamSlug:    "team-a",
		Status:      domain.TaskStatusCompleted,
		Prompt:      "Done task",
		CreatedAt:   now,
		UpdatedAt:   now,
		CompletedAt: &completed,
	}
	store.tasks[task.ID] = task

	handler := NewToolHandler(newTestLogger(t))
	RegisterTaskTools(handler, deps)

	args, _ := json.Marshal(map[string]string{"task_id": "task-done-001"})
	_, err := handler.HandleToolCall("c1", "cancel_task", args)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "already")
}

func TestListTasks_WithPagination(t *testing.T) {
	deps, store, _, _ := newTaskToolsDeps(t)
	now := time.Now()
	for i := 0; i < 5; i++ {
		store.tasks[string(rune('0'+i))] = &domain.Task{
			ID:        string(rune('0' + i)),
			TeamSlug:  "team-x",
			Status:    domain.TaskStatusPending,
			Prompt:    "Task",
			CreatedAt: now,
			UpdatedAt: now,
		}
	}

	handler := NewToolHandler(newTestLogger(t))
	RegisterTaskTools(handler, deps)

	args, _ := json.Marshal(map[string]interface{}{
		"team_slug": "team-x",
		"limit":     3,
	})
	result, err := handler.HandleToolCall("c1", "list_tasks", args)
	require.NoError(t, err)

	var tasks []*domain.Task
	require.NoError(t, json.Unmarshal(result, &tasks))
	assert.LessOrEqual(t, len(tasks), 3)
}

func TestListTasks_ByStatus(t *testing.T) {
	deps, store, _, _ := newTaskToolsDeps(t)
	now := time.Now()
	store.tasks["t1"] = &domain.Task{ID: "t1", TeamSlug: "team-a", Status: domain.TaskStatusRunning, Prompt: "p", CreatedAt: now, UpdatedAt: now}
	store.tasks["t2"] = &domain.Task{ID: "t2", TeamSlug: "team-b", Status: domain.TaskStatusPending, Prompt: "p", CreatedAt: now, UpdatedAt: now}

	handler := NewToolHandler(newTestLogger(t))
	RegisterTaskTools(handler, deps)

	args, _ := json.Marshal(map[string]string{"status": "running"})
	result, err := handler.HandleToolCall("c1", "list_tasks", args)
	require.NoError(t, err)

	var tasks []*domain.Task
	require.NoError(t, json.Unmarshal(result, &tasks))
	require.Len(t, tasks, 1)
	assert.Equal(t, "t1", tasks[0].ID)
}

func TestGetMemberStatus_ByAgentAID(t *testing.T) {
	deps, _, _, orgChart := newTaskToolsDeps(t)
	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{AID: "aid-asst-main0001", Name: "Asst"},
		Agents:    []domain.Agent{{AID: "aid-dev-00000001", Name: "Dev"}},
	}
	require.NoError(t, orgChart.RebuildFromConfig(master, nil))

	handler := NewToolHandler(newTestLogger(t))
	RegisterTaskTools(handler, deps)

	args, _ := json.Marshal(map[string]string{"agent_aid": "aid-dev-00000001"})
	result, err := handler.HandleToolCall("c1", "get_member_status", args)
	require.NoError(t, err)

	var agent domain.Agent
	require.NoError(t, json.Unmarshal(result, &agent))
	assert.Equal(t, "Dev", agent.Name)
}
