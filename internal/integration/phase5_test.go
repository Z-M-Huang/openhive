package integration

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/config"
	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/event"
	"github.com/Z-M-Huang/openhive/internal/orchestrator"
	"github.com/Z-M-Huang/openhive/internal/store"
	"github.com/Z-M-Huang/openhive/internal/ws"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// phase5Setup wires together all Phase 5 components with in-memory stores
// and a real temp-directory config loader.
type phase5Setup struct {
	db          *store.DB
	taskStore   *store.TaskStoreImpl
	wsHub       *ws.Hub
	eventBus    domain.EventBus
	cfgLoader   domain.ConfigLoader
	orgChart    domain.OrgChart
	toolHandler *orchestrator.ToolHandler
	dispatcher  *orchestrator.Dispatcher
	skillLoader *orchestrator.SkillLoader
	logger      *slog.Logger
	tmpDir      string
}

func newPhase5Setup(t *testing.T) *phase5Setup {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelWarn}))

	tmpDir := t.TempDir()

	// Write minimal master config
	masterYAML := `
system:
  listen_address: "127.0.0.1:0"
  data_dir: "` + tmpDir + `"
  log_level: "info"
assistant:
  name: "TestAssistant"
  aid: "aid-testmain-00000001"
  provider: "default"
  model_tier: "sonnet"
channels:
  discord:
    enabled: false
  whatsapp:
    enabled: false
`
	err := os.WriteFile(filepath.Join(tmpDir, "openhive.yaml"), []byte(masterYAML), 0600)
	if err != nil {
		t.Fatalf("write openhive.yaml: %v", err)
	}

	// Write providers.yaml
	err = os.WriteFile(filepath.Join(tmpDir, "providers.yaml"), []byte(
		"providers:\n  default:\n    name: default\n    type: oauth\n    oauth_token: test-oauth-token\n",
	), 0600)
	if err != nil {
		t.Fatalf("write providers.yaml: %v", err)
	}

	db, err := store.NewDB("file:phase5_" + t.Name() + "?mode=memory&cache=shared")
	require.NoError(t, err)

	taskStore := store.NewTaskStore(db)
	eventBus := event.NewEventBus()
	t.Cleanup(eventBus.Close)

	wsHub := ws.NewHub(logger)
	t.Cleanup(wsHub.Close)

	cfgLoader, err := config.NewLoader(tmpDir, tmpDir)
	require.NoError(t, err)

	orgChart := config.NewOrgChart()

	// Initial org chart seeding from the master config
	masterCfg, err := cfgLoader.LoadMaster()
	require.NoError(t, err)

	err = orgChart.RebuildFromConfig(masterCfg, nil)
	require.NoError(t, err)

	// Tool handler with all tools registered
	toolHandler := orchestrator.NewToolHandler(logger)
	toolHandler.SetOrgChart(orgChart)

	orchestrator.RegisterAdminTools(toolHandler, orchestrator.AdminToolsDeps{
		ConfigLoader: cfgLoader,
		WSHub:        wsHub,
		StartTime:    time.Now(),
	})
	orchestrator.RegisterTeamTools(toolHandler, orchestrator.TeamToolsDeps{
		ConfigLoader: cfgLoader,
		OrgChart:     orgChart,
		EventBus:     eventBus,
		Logger:       logger,
	})
	orchestrator.RegisterTaskTools(toolHandler, orchestrator.TaskToolsDeps{
		TaskStore: taskStore,
		WSHub:     wsHub,
		OrgChart:  orgChart,
		Logger:    logger,
	})

	dispatcher := orchestrator.NewDispatcher(taskStore, wsHub, logger)
	wsHub.SetOnMessage(dispatcher.HandleWSMessage)
	dispatcher.SetToolHandler(toolHandler)

	skillLoader := orchestrator.NewSkillLoader(tmpDir, logger)

	return &phase5Setup{
		db:          db,
		taskStore:   taskStore,
		wsHub:       wsHub,
		eventBus:    eventBus,
		cfgLoader:   cfgLoader,
		orgChart:    orgChart,
		toolHandler: toolHandler,
		dispatcher:  dispatcher,
		skillLoader: skillLoader,
		logger:      logger,
		tmpDir:      tmpDir,
	}
}

// TestPhase5_ToolCallPipeline verifies the full tool call pipeline:
// tool name -> ToolHandler authorization -> execute -> result JSON.
func TestPhase5_ToolCallPipeline(t *testing.T) {
	s := newPhase5Setup(t)

	// Main team can call get_system_status (admin tool)
	result, err := s.toolHandler.HandleToolCallWithContext("main", "call-001", "get_system_status", "", json.RawMessage(`{}`))
	require.NoError(t, err)

	var status map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &status))
	assert.Contains(t, status, "uptime")
	assert.Contains(t, status, "version")

	// Main team can call list_teams (team tool)
	result, err = s.toolHandler.HandleToolCallWithContext("main", "call-002", "list_teams", "", json.RawMessage(`{}`))
	require.NoError(t, err)
	assert.NotNil(t, result)

	// get_config returns system config
	result, err = s.toolHandler.HandleToolCallWithContext("main", "call-003", "get_config", "", json.RawMessage(`{"section":"system"}`))
	require.NoError(t, err)

	var sys domain.SystemConfig
	require.NoError(t, json.Unmarshal(result, &sys))
	assert.Equal(t, "info", sys.LogLevel)
}

// TestPhase5_AuthorizationBlocksChildTeam verifies that child team containers
// cannot call admin-only tools.
func TestPhase5_AuthorizationBlocksChildTeam(t *testing.T) {
	s := newPhase5Setup(t)

	// Child team calling a main-only tool should be denied.
	// create_agent is an admin-only tool not in the child team whitelist.
	_, err := s.toolHandler.HandleToolCallWithContext("tid-childteam-0001", "call-denied", "create_agent", "", json.RawMessage(`{"name":"Bot","role_file":"bot.md","team_slug":"master"}`))
	require.Error(t, err)

	var denied *domain.AccessDeniedError
	require.ErrorAs(t, err, &denied)
	assert.Equal(t, "tool", denied.Resource)

	// Child team CAN call allowed tools like list_teams (in childTeamTools whitelist).
	result, err := s.toolHandler.HandleToolCallWithContext("tid-childteam-0001", "call-allowed", "list_teams", "", json.RawMessage(`{}`))
	require.NoError(t, err)
	assert.NotNil(t, result)
}

// TestPhase5_TwoStepTeamCreation verifies the create_agent -> create_team workflow
// updates the OrgChart and publishes a TeamCreated event.
func TestPhase5_TwoStepTeamCreation(t *testing.T) {
	s := newPhase5Setup(t)

	// Track TeamCreated events
	var receivedEvents []domain.Event
	var evMu sync.Mutex
	evDone := make(chan struct{}, 5)

	subID := s.eventBus.Subscribe(domain.EventTypeTeamCreated, func(ev domain.Event) {
		evMu.Lock()
		receivedEvents = append(receivedEvents, ev)
		evMu.Unlock()
		select {
		case evDone <- struct{}{}:
		default:
		}
	})
	defer s.eventBus.Unsubscribe(subID)

	// Step 1: create_agent in the "master" team
	// Use a single-word name to avoid a slug with dashes (which would fail AID validation).
	createAgentArgs := `{"name":"Lead","role_file":"lead.role.md","model_tier":"sonnet","team_slug":"master"}`
	result, err := s.toolHandler.HandleToolCallWithContext("main", "call-ca-001", "create_agent", "", json.RawMessage(createAgentArgs))
	require.NoError(t, err)

	var agentResp map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &agentResp))
	aid, ok := agentResp["aid"].(string)
	require.True(t, ok, "create_agent should return an 'aid' field")
	assert.NotEmpty(t, aid)

	// Step 2: create_team referencing the new leader AID
	createTeamArgs := `{"slug":"integration-team","leader_aid":"` + aid + `","description":"Integration test team"}`
	result, err = s.toolHandler.HandleToolCallWithContext("main", "call-ct-001", "create_team", "", json.RawMessage(createTeamArgs))
	require.NoError(t, err)

	var teamResp map[string]interface{}
	require.NoError(t, json.Unmarshal(result, &teamResp))
	// create_team returns "tid" (team ID) and "slug"
	assert.Contains(t, teamResp, "tid")

	// Wait for the TeamCreated event (async dispatch)
	select {
	case <-evDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for TeamCreated event")
	}

	evMu.Lock()
	assert.GreaterOrEqual(t, len(receivedEvents), 1)
	evMu.Unlock()

	// Verify the team directory was created
	teamDir := filepath.Join(s.tmpDir, "teams", "integration-team")
	_, statErr := os.Stat(teamDir)
	assert.NoError(t, statErr, "team directory should exist after create_team")
}

// TestPhase5_MultiLevelDispatch verifies the task subtree lifecycle:
// parent task created -> sub-tasks added -> sub-tasks completed -> verified via GetSubtree.
func TestPhase5_MultiLevelDispatch(t *testing.T) {
	s := newPhase5Setup(t)
	ctx := context.Background()

	now := time.Now()

	// Create a parent task
	parentTask := &domain.Task{
		ID:        "task-p5-parent-001",
		TeamSlug:  "main",
		AgentAID:  "aid-testmain-00000001",
		JID:       "test:user-001",
		Status:    domain.TaskStatusPending,
		Prompt:    "<user_message>Dispatch parent task</user_message>",
		CreatedAt: now,
		UpdatedAt: now,
	}
	require.NoError(t, s.taskStore.Create(ctx, parentTask))

	// Transition parent to Running via Update
	parentTask.Status = domain.TaskStatusRunning
	parentTask.UpdatedAt = time.Now()
	require.NoError(t, s.taskStore.Update(ctx, parentTask))

	// Create sub-tasks
	sub1 := &domain.Task{
		ID:        "task-p5-sub-001",
		TeamSlug:  "main",
		AgentAID:  "aid-testmain-00000001",
		ParentID:  parentTask.ID,
		Status:    domain.TaskStatusPending,
		Prompt:    "Subtask 1",
		CreatedAt: now,
		UpdatedAt: now,
	}
	sub2 := &domain.Task{
		ID:        "task-p5-sub-002",
		TeamSlug:  "main",
		AgentAID:  "aid-testmain-00000001",
		ParentID:  parentTask.ID,
		Status:    domain.TaskStatusPending,
		Prompt:    "Subtask 2",
		CreatedAt: now,
		UpdatedAt: now,
	}
	require.NoError(t, s.taskStore.Create(ctx, sub1))
	require.NoError(t, s.taskStore.Create(ctx, sub2))

	// Verify sub-tasks are in store via GetSubtree
	subtree, err := s.taskStore.GetSubtree(ctx, parentTask.ID)
	require.NoError(t, err)
	// GetSubtree returns parent + children; filter for children only
	children := make([]*domain.Task, 0)
	for _, task := range subtree {
		if task.ParentID == parentTask.ID {
			children = append(children, task)
		}
	}
	assert.Len(t, children, 2)

	// Complete the first sub-task
	sub1.Status = domain.TaskStatusRunning
	sub1.UpdatedAt = time.Now()
	require.NoError(t, s.taskStore.Update(ctx, sub1))
	sub1.Status = domain.TaskStatusCompleted
	sub1.Result = "Result from sub1"
	sub1.UpdatedAt = time.Now()
	require.NoError(t, s.taskStore.Update(ctx, sub1))

	// Complete the second sub-task
	sub2.Status = domain.TaskStatusRunning
	sub2.UpdatedAt = time.Now()
	require.NoError(t, s.taskStore.Update(ctx, sub2))
	sub2.Status = domain.TaskStatusCompleted
	sub2.Result = "Result from sub2"
	sub2.UpdatedAt = time.Now()
	require.NoError(t, s.taskStore.Update(ctx, sub2))

	// Verify all sub-tasks are completed via GetSubtree
	subtree, err = s.taskStore.GetSubtree(ctx, parentTask.ID)
	require.NoError(t, err)
	for _, task := range subtree {
		if task.ParentID == parentTask.ID {
			assert.Equal(t, domain.TaskStatusCompleted, task.Status)
			assert.NotEmpty(t, task.Result)
		}
	}
}

// TestPhase5_SkillLoading verifies that skills can be written to disk
// and loaded back with all fields intact.
func TestPhase5_SkillLoading(t *testing.T) {
	s := newPhase5Setup(t)

	// Create team directory and skills subdirectory
	skillsDir := filepath.Join(s.tmpDir, "teams", "skills-team", "skills")
	require.NoError(t, os.MkdirAll(skillsDir, 0700))

	// Write a test skill YAML
	skillYAML := `name: code-review
description: Reviews Go code for correctness and style
model_tier: sonnet
tools:
  - read_file
  - write_file
parameters:
  max_files: 10
  style_guide: "google"
`
	skillPath := filepath.Join(skillsDir, "code-review.yaml")
	require.NoError(t, os.WriteFile(skillPath, []byte(skillYAML), 0600))

	// Load the skill
	skill, err := s.skillLoader.LoadSkill("skills-team", "code-review")
	require.NoError(t, err)
	assert.Equal(t, "code-review", skill.Name)
	assert.Equal(t, "Reviews Go code for correctness and style", skill.Description)
	assert.Equal(t, "sonnet", skill.ModelTier)
	assert.Equal(t, []string{"read_file", "write_file"}, skill.Tools)

	// Path traversal attempt should be rejected
	_, err = s.skillLoader.LoadSkill("skills-team", "../../../etc/passwd")
	assert.Error(t, err, "path traversal should be rejected")

	// Invalid team slug should be rejected
	_, err = s.skillLoader.LoadSkill("../../../etc", "skill")
	assert.Error(t, err, "path traversal in team slug should be rejected")

	// Load non-existent skill
	_, err = s.skillLoader.LoadSkill("skills-team", "nonexistent")
	require.Error(t, err)
	var notFound *domain.NotFoundError
	assert.ErrorAs(t, err, &notFound)
}

// TestPhase5_FilteredSubscription verifies that the event bus filtered subscriptions
// only deliver events matching the filter predicate.
func TestPhase5_FilteredSubscription(t *testing.T) {
	s := newPhase5Setup(t)

	var infoEvents []domain.Event
	var debugEvents []domain.Event
	var mu sync.Mutex
	var wg sync.WaitGroup

	// Subscribe with info-level filter (should only receive Info and above)
	infoSubID := s.eventBus.FilteredSubscribe(
		domain.EventTypeLogEntry,
		func(ev domain.Event) bool {
			entry, ok := ev.Payload.(*domain.LogEntry)
			if !ok {
				return false
			}
			return entry.Level >= domain.LogLevelInfo
		},
		func(ev domain.Event) {
			mu.Lock()
			infoEvents = append(infoEvents, ev)
			mu.Unlock()
			wg.Done()
		},
	)
	defer s.eventBus.Unsubscribe(infoSubID)

	// Subscribe with debug-level filter (should receive all)
	debugSubID := s.eventBus.FilteredSubscribe(
		domain.EventTypeLogEntry,
		func(ev domain.Event) bool {
			entry, ok := ev.Payload.(*domain.LogEntry)
			if !ok {
				return false
			}
			return entry.Level >= domain.LogLevelDebug
		},
		func(ev domain.Event) {
			mu.Lock()
			debugEvents = append(debugEvents, ev)
			mu.Unlock()
			wg.Done()
		},
	)
	defer s.eventBus.Unsubscribe(debugSubID)

	// Publish one Debug and one Info event.
	// debugSubID receives both; infoSubID receives only the Info event.
	wg.Add(1) // debug subscriber gets debug event
	s.eventBus.Publish(domain.Event{
		Type: domain.EventTypeLogEntry,
		Payload: &domain.LogEntry{
			Level:   domain.LogLevelDebug,
			Message: "debug message",
		},
	})

	wg.Add(2) // both subscribers get info event
	s.eventBus.Publish(domain.Event{
		Type: domain.EventTypeLogEntry,
		Payload: &domain.LogEntry{
			Level:   domain.LogLevelInfo,
			Message: "info message",
		},
	})

	// Wait with timeout
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for event delivery")
	}

	mu.Lock()
	defer mu.Unlock()

	// infoSubID should only have 1 event (the Info one)
	require.Len(t, infoEvents, 1)
	infoEntry := infoEvents[0].Payload.(*domain.LogEntry)
	assert.Equal(t, domain.LogLevelInfo, infoEntry.Level)

	// debugSubID should have both events
	assert.GreaterOrEqual(t, len(debugEvents), 2)
}

// TestPhase5_AuthorizationRejectsTraversal verifies that path traversal attempts
// and invalid slugs are rejected by validation functions.
func TestPhase5_AuthorizationRejectsTraversal(t *testing.T) {
	// ValidateSlug rejects paths and traversal attempts
	traversalCases := []struct {
		slug string
		desc string
	}{
		{"../etc/passwd", "path traversal with .."},
		{"/absolute/path", "absolute path"},
		{"slug with spaces", "slug with spaces"},
		{"UPPER-CASE", "uppercase letters"},
		{"has.dot", "dot in slug"},
		{"", "empty slug"},
	}

	for _, tc := range traversalCases {
		err := domain.ValidateSlug(tc.slug)
		assert.Error(t, err, "ValidateSlug should reject: %s (%s)", tc.slug, tc.desc)
	}

	// Valid slugs pass
	validSlugs := []string{
		"team-alpha",
		"my-team-001",
		"a",
		"abc-123",
	}
	for _, slug := range validSlugs {
		err := domain.ValidateSlug(slug)
		assert.NoError(t, err, "ValidateSlug should accept: %s", slug)
	}
}

// TestPhase5_CopyFileWithContainment verifies that CopyFileWithContainment
// safely copies files and rejects traversal attempts.
// The function signature is CopyFileWithContainment(srcRoot, destRoot, relPath, logger).
func TestPhase5_CopyFileWithContainment(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()

	// Create test source file
	srcContent := []byte("hello world content")
	srcFile := filepath.Join(srcDir, "data.txt")
	require.NoError(t, os.WriteFile(srcFile, srcContent, 0600))

	// Valid copy: relPath "data.txt" is copied from srcDir to dstDir
	err := orchestrator.CopyFileWithContainment(srcDir, dstDir, "data.txt", nil)
	require.NoError(t, err)

	got, err := os.ReadFile(filepath.Join(dstDir, "data.txt"))
	require.NoError(t, err)
	assert.Equal(t, srcContent, got)

	// Path traversal in relPath should be rejected (contains "..")
	err = orchestrator.CopyFileWithContainment(srcDir, dstDir, "../../../etc/passwd", nil)
	assert.Error(t, err, "should reject path traversal in relPath")

	// Absolute relPath should be rejected
	err = orchestrator.CopyFileWithContainment(srcDir, dstDir, "/etc/passwd", nil)
	assert.Error(t, err, "should reject absolute relPath")
}

// TestPhase5_GoOrchestratorStartStop verifies the GoOrchestrator lifecycle:
// Start starts the stale reaper, Stop shuts it down cleanly.
func TestPhase5_GoOrchestratorStartStop(t *testing.T) {
	s := newPhase5Setup(t)
	ctx := context.Background()

	orch := orchestrator.NewGoOrchestrator(orchestrator.OrchestratorDeps{
		TaskStore: s.taskStore,
		WSHub:     s.wsHub,
		OrgChart:  s.orgChart,
		EventBus:  s.eventBus,
		Dispatcher: s.dispatcher,
		Logger:    s.logger,
	})

	// Start should succeed
	require.NoError(t, orch.Start(ctx))

	// Stop should succeed cleanly
	require.NoError(t, orch.Stop())
}
