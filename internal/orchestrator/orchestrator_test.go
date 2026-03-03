package orchestrator

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/config"
	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// compile-time assertion to ensure GoOrchestratorImpl satisfies domain.GoOrchestrator
var _ domain.GoOrchestrator = (*GoOrchestratorImpl)(nil)

// --- helpers ---

// newOrchestratorDeps creates an OrchestratorDeps with in-memory mocks and a
// temp directory config loader.
func newOrchestratorDeps(t *testing.T) (OrchestratorDeps, *memTaskStore, *mockWSHubForTaskTools) {
	t.Helper()
	taskStore := newMemTaskStore()
	wsHub := &mockWSHubForTaskTools{}
	orgChart := config.NewOrgChart()
	logger := newTestLogger(t)

	// Seed a minimal orgchart
	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{AID: "aid-asst-main0001", Name: "Main"},
		Agents:    []domain.Agent{{AID: "aid-lead-00000001", Name: "Lead"}},
	}
	teamA := &domain.Team{
		Slug:      "team-a",
		TID:       "tid-teama00000001",
		LeaderAID: "aid-lead-00000001",
		Agents: []domain.Agent{
			{AID: "aid-dev-00000001", Name: "Dev"},
		},
	}
	require.NoError(t, orgChart.RebuildFromConfig(master, map[string]*domain.Team{"team-a": teamA}))

	// Create a temp data dir for config loader
	dataDir := t.TempDir()
	teamsDir := filepath.Join(dataDir, "teams", "team-a")
	require.NoError(t, os.MkdirAll(teamsDir, 0755))

	// Write a minimal master config
	masterYAML := `system:
  log_level: warn
assistant:
  aid: "aid-asst-main0001"
  name: "Main"
  provider: default
  model_tier: sonnet
agents:
  - aid: "aid-lead-00000001"
    name: "Lead"
`
	require.NoError(t, os.WriteFile(filepath.Join(dataDir, "openhive.yaml"), []byte(masterYAML), 0600))

	// Write team config
	teamYAML := `tid: "tid-teama00000001"
slug: "team-a"
leader_aid: "aid-lead-00000001"
agents:
  - aid: "aid-dev-00000001"
    name: "Dev"
`
	require.NoError(t, os.WriteFile(filepath.Join(teamsDir, "team.yaml"), []byte(teamYAML), 0600))

	cfgLoader, err := config.NewLoader(dataDir, dataDir)
	require.NoError(t, err)

	hbMonitor := NewHeartbeatMonitorWithIntervals(nil, logger, 100*time.Millisecond, 200*time.Millisecond)

	deps := OrchestratorDeps{
		TaskStore:        taskStore,
		WSHub:            wsHub,
		ContainerManager: nil, // tested separately
		OrgChart:         orgChart,
		ConfigLoader:     cfgLoader,
		HeartbeatMonitor: hbMonitor,
		EventBus:         nil,
		Dispatcher:       nil,
		Logger:           logger,
	}
	return deps, taskStore, wsHub
}

// --- DispatchTask ---

func TestDispatchTask_ValidatesHierarchyViaOrgChart(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	task := &domain.Task{
		AgentAID: "aid-nonexistent-00001",
		Prompt:   "Do something",
	}
	err := orch.DispatchTask(ctx, task)
	require.Error(t, err)

	var nfe *domain.NotFoundError
	assert.ErrorAs(t, err, &nfe)
	assert.Equal(t, "agent", nfe.Resource)
}

func TestDispatchTask_RequiresPrompt(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	task := &domain.Task{
		AgentAID: "aid-dev-00000001",
		Prompt:   "",
	}
	err := orch.DispatchTask(ctx, task)
	require.Error(t, err)

	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestDispatchTask_CreatesTaskAndSendsViaWS(t *testing.T) {
	deps, taskStore, wsHub := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	task := &domain.Task{
		AgentAID: "aid-dev-00000001",
		Prompt:   "Analyze the data",
	}
	err := orch.DispatchTask(ctx, task)
	require.NoError(t, err)

	// Task should be in store
	assert.Len(t, taskStore.tasks, 1)
	assert.NotEmpty(t, task.ID)
	assert.Equal(t, "team-a", task.TeamSlug)

	// WS message should be sent
	assert.Equal(t, "team-a", wsHub.sentTeam)
	assert.NotEmpty(t, wsHub.sentMessages)
}

func TestDispatchTask_SetsTaskIDIfEmpty(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	task := &domain.Task{
		AgentAID: "aid-dev-00000001",
		Prompt:   "Work",
	}
	require.NoError(t, orch.DispatchTask(ctx, task))
	assert.NotEmpty(t, task.ID)
}

// --- HandleTaskResult ---

func TestHandleTaskResult_UpdatesTaskStatus(t *testing.T) {
	deps, taskStore, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	now := time.Now()
	task := &domain.Task{
		ID:        "task-result-001",
		TeamSlug:  "team-a",
		AgentAID:  "aid-dev-00000001",
		Status:    domain.TaskStatusRunning,
		Prompt:    "Analyze",
		CreatedAt: now,
		UpdatedAt: now,
	}
	taskStore.tasks[task.ID] = task

	err := orch.HandleTaskResult(ctx, task.ID, "Analysis complete", "")
	require.NoError(t, err)

	updated := taskStore.tasks[task.ID]
	assert.Equal(t, domain.TaskStatusCompleted, updated.Status)
	assert.Equal(t, "Analysis complete", updated.Result)
	assert.NotNil(t, updated.CompletedAt)
}

func TestHandleTaskResult_FailedResult(t *testing.T) {
	deps, taskStore, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	now := time.Now()
	task := &domain.Task{
		ID:        "task-fail-001",
		TeamSlug:  "team-a",
		Status:    domain.TaskStatusRunning,
		Prompt:    "Fail",
		CreatedAt: now,
		UpdatedAt: now,
	}
	taskStore.tasks[task.ID] = task

	err := orch.HandleTaskResult(ctx, task.ID, "", "container crashed")
	require.NoError(t, err)

	updated := taskStore.tasks[task.ID]
	assert.Equal(t, domain.TaskStatusFailed, updated.Status)
	assert.Equal(t, "container crashed", updated.Error)
}

func TestHandleTaskResult_ConsolidatesSubtasksWhenAllDone(t *testing.T) {
	deps, taskStore, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	now := time.Now()

	// Parent task
	parent := &domain.Task{
		ID:        "parent-001",
		TeamSlug:  "team-a",
		Status:    domain.TaskStatusRunning,
		Prompt:    "Parent",
		CreatedAt: now,
		UpdatedAt: now,
	}
	taskStore.tasks[parent.ID] = parent

	// Subtask 1 (already completed)
	sub1 := &domain.Task{
		ID:        "sub-001",
		ParentID:  parent.ID,
		TeamSlug:  "team-a",
		Status:    domain.TaskStatusCompleted,
		Prompt:    "Sub 1",
		Result:    "Result from sub 1",
		CreatedAt: now,
		UpdatedAt: now,
	}
	taskStore.tasks[sub1.ID] = sub1

	// Subtask 2 (completing now)
	sub2 := &domain.Task{
		ID:        "sub-002",
		ParentID:  parent.ID,
		TeamSlug:  "team-a",
		Status:    domain.TaskStatusRunning,
		Prompt:    "Sub 2",
		CreatedAt: now,
		UpdatedAt: now,
	}
	taskStore.tasks[sub2.ID] = sub2

	// Complete sub2 — should trigger consolidation
	err := orch.HandleTaskResult(ctx, sub2.ID, "Result from sub 2", "")
	require.NoError(t, err)

	// Parent should now be completed with consolidated results
	updatedParent := taskStore.tasks[parent.ID]
	assert.Equal(t, domain.TaskStatusCompleted, updatedParent.Status)
	assert.Contains(t, updatedParent.Result, "Result from sub 1")
	assert.Contains(t, updatedParent.Result, "Result from sub 2")
}

func TestHandleTaskResult_ReturnsNotFoundForUnknownTask(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	err := orch.HandleTaskResult(ctx, "nonexistent-task", "result", "")
	require.Error(t, err)
}

// --- CancelTask ---

func TestCancelTask_SendsCancelToContainer(t *testing.T) {
	deps, taskStore, wsHub := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	now := time.Now()
	task := &domain.Task{
		ID:        "cancel-001",
		TeamSlug:  "team-a",
		Status:    domain.TaskStatusRunning,
		Prompt:    "Running task",
		CreatedAt: now,
		UpdatedAt: now,
	}
	taskStore.tasks[task.ID] = task

	err := orch.CancelTask(ctx, task.ID)
	require.NoError(t, err)

	// Task status updated
	updated := taskStore.tasks[task.ID]
	assert.Equal(t, domain.TaskStatusCancelled, updated.Status)

	// Cancel message sent to container
	assert.NotEmpty(t, wsHub.sentMessages)
}

func TestCancelTask_RejectsAlreadyCompleted(t *testing.T) {
	deps, taskStore, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	now := time.Now()
	task := &domain.Task{
		ID:        "done-001",
		TeamSlug:  "team-a",
		Status:    domain.TaskStatusCompleted,
		Prompt:    "Done",
		CreatedAt: now,
		UpdatedAt: now,
	}
	taskStore.tasks[task.ID] = task

	err := orch.CancelTask(ctx, task.ID)
	require.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
}

// --- CreateSubtasks ---

func TestCreateSubtasks_DecomposesTask(t *testing.T) {
	deps, taskStore, wsHub := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	// Re-seed orgchart so that team-a's leader (aid-lead-00000001) is actually
	// a member of team-a (required for GetTeamForAgent to resolve it).
	orgChart := deps.OrgChart.(*config.OrgChartService)
	master := &domain.MasterConfig{
		Assistant: domain.AssistantConfig{AID: "aid-asst-main0001", Name: "Main"},
	}
	teamA := &domain.Team{
		Slug:      "team-a",
		TID:       "tid-teama00000001",
		LeaderAID: "aid-lead-00000001",
		Agents: []domain.Agent{
			{AID: "aid-lead-00000001", Name: "Lead"},
			{AID: "aid-dev-00000001", Name: "Dev"},
		},
	}
	require.NoError(t, orgChart.RebuildFromConfig(master, map[string]*domain.Team{"team-a": teamA}))

	ctx := context.Background()
	now := time.Now()
	parent := &domain.Task{
		ID:        "parent-sub-001",
		TeamSlug:  "team-a",
		Status:    domain.TaskStatusRunning,
		Prompt:    "Parent",
		CreatedAt: now,
		UpdatedAt: now,
	}
	taskStore.tasks[parent.ID] = parent

	subtasks, err := orch.CreateSubtasks(ctx, parent.ID, []string{
		"Subtask A",
		"Subtask B",
	}, "team-a")
	require.NoError(t, err)
	assert.Len(t, subtasks, 2)

	// All subtasks should have the parent ID set
	for _, st := range subtasks {
		assert.Equal(t, parent.ID, st.ParentID)
		assert.Equal(t, "team-a", st.TeamSlug)
	}

	// WS messages should be sent
	assert.NotEmpty(t, wsHub.sentMessages)
}

func TestCreateSubtasks_RequiresParent(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	_, err := orch.CreateSubtasks(ctx, "", []string{"prompt"}, "team-a")
	require.Error(t, err)
}

// --- GetTeam / ListTeams / UpdateTeam ---

func TestGetTeam_LoadsFromConfigLoader(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	team, err := orch.GetTeam(ctx, "team-a")
	require.NoError(t, err)
	assert.Equal(t, "team-a", team.Slug)
}

func TestGetTeam_RejectsInvalidSlug(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	_, err := orch.GetTeam(ctx, "../etc/passwd")
	require.Error(t, err)
}

func TestListTeams_ReturnsAllFromOrgChart(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	teams, err := orch.ListTeams(ctx)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, len(teams), 1)
}

// --- GetHealthStatus / GetAllStatuses ---

func TestGetHealthStatus_ReturnsNotFoundIfNoHeartbeat(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	_, err := orch.GetHealthStatus("team-a")
	require.Error(t, err)
	var nfe *domain.NotFoundError
	assert.ErrorAs(t, err, &nfe)
}

func TestGetAllStatuses_ReturnsEmptyMapWhenNoHeartbeats(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	statuses := orch.GetAllStatuses()
	assert.NotNil(t, statuses)
}

// --- HandleUnhealthy ---

func TestHandleUnhealthy_ReturnsNilWhenNoContainerManager(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	// ContainerManager is nil in test deps
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()
	err := orch.HandleUnhealthy(ctx, "team-a")
	require.NoError(t, err)
}

// --- Start / Stop ---

func TestStart_WiresHeartbeatAndStartsReaper(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err := orch.Start(ctx)
	require.NoError(t, err)

	// Stop should complete cleanly
	err = orch.Stop()
	require.NoError(t, err)
}

func TestStop_CleanupGoroutines(t *testing.T) {
	deps, _, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx, cancel := context.WithCancel(context.Background())
	require.NoError(t, orch.Start(ctx))
	cancel()

	// Second stop should be idempotent
	require.NoError(t, orch.Stop())
	require.NoError(t, orch.Stop())
}

// --- Stale task reaper ---

func TestStaleReaper_MarksStuckTasksAsFailed(t *testing.T) {
	deps, taskStore, _ := newOrchestratorDeps(t)
	orch := NewGoOrchestrator(deps)

	ctx := context.Background()

	// Insert a task that is "stuck in running" well past the timeout
	staleTime := time.Now().Add(-2 * staleTaskTimeout)
	stuckTask := &domain.Task{
		ID:        "stuck-001",
		TeamSlug:  "team-a",
		Status:    domain.TaskStatusRunning,
		Prompt:    "Stuck task",
		CreatedAt: staleTime,
		UpdatedAt: staleTime,
	}
	taskStore.tasks[stuckTask.ID] = stuckTask

	// Also add a recent task that should NOT be reaped
	recentTask := &domain.Task{
		ID:        "recent-001",
		TeamSlug:  "team-a",
		Status:    domain.TaskStatusRunning,
		Prompt:    "Recent task",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	taskStore.tasks[recentTask.ID] = recentTask

	// Invoke reaper directly
	orch.reapStaleTasks(ctx)

	// Stuck task should be failed
	assert.Equal(t, domain.TaskStatusFailed, taskStore.tasks["stuck-001"].Status)
	assert.NotEmpty(t, taskStore.tasks["stuck-001"].Error)

	// Recent task should remain running
	assert.Equal(t, domain.TaskStatusRunning, taskStore.tasks["recent-001"].Status)
}

// --- CopyFileWithContainment ---

func TestFileCopy_RejectsPathTraversal(t *testing.T) {
	srcRoot := t.TempDir()
	destRoot := t.TempDir()

	err := CopyFileWithContainment(srcRoot, destRoot, "../../../etc/passwd", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "traversal")
}

func TestFileCopy_RejectsAbsolutePath(t *testing.T) {
	srcRoot := t.TempDir()
	destRoot := t.TempDir()

	err := CopyFileWithContainment(srcRoot, destRoot, "/etc/passwd", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "absolute")
}

func TestFileCopy_CopiesFileSuccessfully(t *testing.T) {
	srcRoot := t.TempDir()
	destRoot := t.TempDir()

	// Create source file
	srcPath := filepath.Join(srcRoot, "data.txt")
	require.NoError(t, os.WriteFile(srcPath, []byte("hello world"), 0600))

	err := CopyFileWithContainment(srcRoot, destRoot, "data.txt", newTestLogger(t))
	require.NoError(t, err)

	// Verify destination file
	destPath := filepath.Join(destRoot, "data.txt")
	content, err := os.ReadFile(destPath)
	require.NoError(t, err)
	assert.Equal(t, "hello world", string(content))
}

func TestFileCopy_LogsOperationDetails(t *testing.T) {
	srcRoot := t.TempDir()
	destRoot := t.TempDir()

	srcPath := filepath.Join(srcRoot, "logme.txt")
	require.NoError(t, os.WriteFile(srcPath, []byte("log this"), 0600))

	// Pass a real logger — should not panic or error
	logger := newTestLogger(t)
	err := CopyFileWithContainment(srcRoot, destRoot, "logme.txt", logger)
	require.NoError(t, err)
}

func TestFileCopy_CreatesDestinationDirectories(t *testing.T) {
	srcRoot := t.TempDir()
	destRoot := t.TempDir()

	// Create source file in nested directory
	subDir := filepath.Join(srcRoot, "a", "b")
	require.NoError(t, os.MkdirAll(subDir, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(subDir, "file.txt"), []byte("nested"), 0600))

	err := CopyFileWithContainment(srcRoot, destRoot, filepath.Join("a", "b", "file.txt"), nil)
	require.NoError(t, err)

	destFile := filepath.Join(destRoot, "a", "b", "file.txt")
	content, err := os.ReadFile(destFile)
	require.NoError(t, err)
	assert.Equal(t, "nested", string(content))
}
