package orchestrator

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/ws"
	"github.com/google/uuid"
)

const (
	// staleTaskTimeout is the maximum time a task can remain in the Running state
	// before the stale reaper marks it as failed.
	staleTaskTimeout = 30 * time.Minute

	// staleReaperInterval is how often the stale reaper checks for stuck tasks.
	staleReaperInterval = 5 * time.Minute
)

// GoOrchestratorImpl implements domain.GoOrchestrator.
// It combines TeamProvisioner, TaskCoordinator, and HealthManager responsibilities.
type GoOrchestratorImpl struct {
	taskStore        domain.TaskStore
	wsHub            domain.WSHub
	containerManager domain.ContainerManager
	orgChart         domain.OrgChart
	configLoader     domain.ConfigLoader
	heartbeatMonitor domain.HeartbeatMonitor
	eventBus         domain.EventBus
	dispatcher       *Dispatcher
	logger           *slog.Logger

	staleReaperStop chan struct{}
	staleReaperDone chan struct{}
	startOnce       sync.Once
	stopOnce        sync.Once
}

// OrchestratorDeps holds dependencies for GoOrchestratorImpl.
type OrchestratorDeps struct {
	TaskStore        domain.TaskStore
	WSHub            domain.WSHub
	ContainerManager domain.ContainerManager
	OrgChart         domain.OrgChart
	ConfigLoader     domain.ConfigLoader
	HeartbeatMonitor domain.HeartbeatMonitor
	EventBus         domain.EventBus
	Dispatcher       *Dispatcher
	Logger           *slog.Logger
}

// NewGoOrchestrator creates a GoOrchestratorImpl.
func NewGoOrchestrator(deps OrchestratorDeps) *GoOrchestratorImpl {
	return &GoOrchestratorImpl{
		taskStore:        deps.TaskStore,
		wsHub:            deps.WSHub,
		containerManager: deps.ContainerManager,
		orgChart:         deps.OrgChart,
		configLoader:     deps.ConfigLoader,
		heartbeatMonitor: deps.HeartbeatMonitor,
		eventBus:         deps.EventBus,
		dispatcher:       deps.Dispatcher,
		logger:           deps.Logger,
		staleReaperStop:  make(chan struct{}),
		staleReaperDone:  make(chan struct{}),
	}
}

// --- Lifecycle ---

// Start starts the heartbeat monitor, wires the unhealthy callback, and starts
// the stale task reaper.
func (o *GoOrchestratorImpl) Start(ctx context.Context) error {
	var startErr error
	o.startOnce.Do(func() {
		// Wire heartbeat unhealthy callback to HandleUnhealthy.
		if o.heartbeatMonitor != nil {
			o.heartbeatMonitor.SetOnUnhealthy(func(teamID string) {
				handleCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := o.HandleUnhealthy(handleCtx, teamID); err != nil {
					o.logger.Error("failed to handle unhealthy team",
						"team_id", teamID,
						"error", err,
					)
				}
			})
			o.heartbeatMonitor.StartMonitoring()
			o.logger.Info("heartbeat monitor started")
		}

		// Start stale task reaper goroutine.
		go o.staleReaperLoop(ctx)
		o.logger.Info("stale task reaper started", "interval", staleReaperInterval, "timeout", staleTaskTimeout)
	})
	return startErr
}

// Stop stops the heartbeat monitor and stale task reaper.
func (o *GoOrchestratorImpl) Stop() error {
	var stopErr error
	o.stopOnce.Do(func() {
		if o.heartbeatMonitor != nil {
			o.heartbeatMonitor.StopMonitoring()
			o.logger.Info("heartbeat monitor stopped")
		}

		// Signal stale reaper to stop and wait for it to finish.
		select {
		case <-o.staleReaperStop:
			// already closed
		default:
			close(o.staleReaperStop)
		}
		select {
		case <-o.staleReaperDone:
		case <-time.After(10 * time.Second):
			o.logger.Warn("stale reaper did not stop in time")
		}
		o.logger.Info("stale task reaper stopped")
	})
	return stopErr
}

// staleReaperLoop runs the stale task detection loop.
func (o *GoOrchestratorImpl) staleReaperLoop(ctx context.Context) {
	defer close(o.staleReaperDone)

	ticker := time.NewTicker(staleReaperInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			o.reapStaleTasks(ctx)
		case <-ctx.Done():
			return
		case <-o.staleReaperStop:
			return
		}
	}
}

// reapStaleTasks finds tasks stuck in Running state beyond staleTaskTimeout and
// marks them as failed.
func (o *GoOrchestratorImpl) reapStaleTasks(ctx context.Context) {
	tasks, err := o.taskStore.ListByStatus(ctx, domain.TaskStatusRunning)
	if err != nil {
		o.logger.Error("stale reaper: failed to list running tasks", "error", err)
		return
	}

	threshold := time.Now().Add(-staleTaskTimeout)
	for _, task := range tasks {
		if task.UpdatedAt.Before(threshold) {
			now := time.Now()
			task.Status = domain.TaskStatusFailed
			task.Error = "task timed out: exceeded stale task threshold"
			task.UpdatedAt = now
			task.CompletedAt = &now

			if updateErr := o.taskStore.Update(ctx, task); updateErr != nil {
				o.logger.Error("stale reaper: failed to mark task as failed",
					"task_id", task.ID,
					"error", updateErr,
				)
				continue
			}

			o.logger.Warn("stale reaper: marked stale task as failed",
				"task_id", task.ID,
				"team_slug", task.TeamSlug,
				"stale_since", task.UpdatedAt,
			)

			if o.eventBus != nil {
				o.eventBus.Publish(domain.Event{
					Type:    domain.EventTypeTaskFailed,
					Payload: task,
				})
			}
		}
	}
}

// --- TeamProvisioner ---

// CreateTeam validates inputs, creates the team config, and provisions a container.
func (o *GoOrchestratorImpl) CreateTeam(ctx context.Context, slug string, leaderAID string) (*domain.Team, error) {
	if err := domain.ValidateSlug(slug); err != nil {
		return nil, err
	}
	if err := domain.ValidateAID(leaderAID); err != nil {
		return nil, err
	}

	// Verify leader exists in OrgChart.
	if _, err := o.orgChart.GetAgentByAID(leaderAID); err != nil {
		return nil, &domain.ValidationError{
			Field:   "leader_aid",
			Message: fmt.Sprintf("agent %s does not exist", leaderAID),
		}
	}

	// Check slug uniqueness.
	if existing, _ := o.orgChart.GetTeamBySlug(slug); existing != nil {
		return nil, &domain.ConflictError{Resource: "team", Message: fmt.Sprintf("team %s already exists", slug)}
	}

	// Generate TID.
	shortID := uuid.NewString()[:8]
	tid := fmt.Sprintf("tid-%s-%s", slug[:minInt(8, len(slug))], shortID)

	team := &domain.Team{
		TID:       tid,
		Slug:      slug,
		LeaderAID: leaderAID,
	}

	if err := o.configLoader.CreateTeamDir(slug); err != nil {
		return nil, fmt.Errorf("failed to create team directory: %w", err)
	}
	if err := o.configLoader.SaveTeam(slug, team); err != nil {
		return nil, fmt.Errorf("failed to save team config: %w", err)
	}

	// Provision container (best-effort: don't fail team creation if provisioning fails).
	if o.containerManager != nil {
		if err := o.containerManager.ProvisionTeam(ctx, slug, nil); err != nil {
			o.logger.Warn("failed to provision container for new team",
				"slug", slug,
				"error", err,
			)
		}
	}

	// Rebuild OrgChart.
	if rebuildErr := o.rebuildOrgChart(); rebuildErr != nil {
		o.logger.Warn("failed to rebuild orgchart after CreateTeam", "error", rebuildErr)
	}

	// Publish event.
	if o.eventBus != nil {
		o.eventBus.Publish(domain.Event{
			Type:    domain.EventTypeTeamCreated,
			Payload: team,
		})
	}

	o.logger.Info("team created", "slug", slug, "tid", tid, "leader_aid", leaderAID)
	return team, nil
}

// DeleteTeam stops the container and removes the team config directory.
func (o *GoOrchestratorImpl) DeleteTeam(ctx context.Context, slug string) error {
	if err := domain.ValidateSlug(slug); err != nil {
		return err
	}

	// Verify team exists.
	if _, err := o.orgChart.GetTeamBySlug(slug); err != nil {
		return &domain.NotFoundError{Resource: "team", ID: slug}
	}

	// Stop and remove container (best-effort).
	if o.containerManager != nil {
		if err := o.containerManager.RemoveTeam(ctx, slug); err != nil {
			o.logger.Warn("failed to remove container for team",
				"slug", slug,
				"error", err,
			)
		}
	}

	// Remove config directory.
	if err := o.configLoader.DeleteTeamDir(slug); err != nil {
		return fmt.Errorf("failed to delete team directory: %w", err)
	}

	// Rebuild OrgChart.
	if rebuildErr := o.rebuildOrgChart(); rebuildErr != nil {
		o.logger.Warn("failed to rebuild orgchart after DeleteTeam", "error", rebuildErr)
	}

	// Publish event.
	if o.eventBus != nil {
		o.eventBus.Publish(domain.Event{
			Type:    domain.EventTypeTeamDeleted,
			Payload: map[string]string{"slug": slug},
		})
	}

	o.logger.Info("team deleted", "slug", slug)
	return nil
}

// GetTeam returns the team configuration for the given slug.
func (o *GoOrchestratorImpl) GetTeam(ctx context.Context, slug string) (*domain.Team, error) {
	if err := domain.ValidateSlug(slug); err != nil {
		return nil, err
	}
	return o.configLoader.LoadTeam(slug)
}

// ListTeams returns all teams from the OrgChart.
func (o *GoOrchestratorImpl) ListTeams(ctx context.Context) ([]*domain.Team, error) {
	chart := o.orgChart.GetOrgChart()
	teams := make([]*domain.Team, 0, len(chart))
	for _, t := range chart {
		teams = append(teams, t)
	}
	return teams, nil
}

// UpdateTeam updates whitelisted fields of a team configuration.
func (o *GoOrchestratorImpl) UpdateTeam(ctx context.Context, slug string, updates map[string]interface{}) (*domain.Team, error) {
	if err := domain.ValidateSlug(slug); err != nil {
		return nil, err
	}

	team, err := o.configLoader.LoadTeam(slug)
	if err != nil {
		return nil, err
	}

	for field, value := range updates {
		switch field {
		case "env_vars":
			if v, ok := value.(map[string]string); ok {
				team.EnvVars = v
			} else {
				return nil, &domain.ValidationError{Field: "env_vars", Message: "must be a string map"}
			}
		case "container_config":
			if v, ok := value.(domain.ContainerConfig); ok {
				team.ContainerConfig = v
			} else {
				return nil, &domain.ValidationError{Field: "container_config", Message: "must be a ContainerConfig"}
			}
		default:
			return nil, &domain.ValidationError{
				Field:   field,
				Message: fmt.Sprintf("field %q is not updatable", field),
			}
		}
	}

	if err := o.configLoader.SaveTeam(slug, team); err != nil {
		return nil, fmt.Errorf("failed to save team config: %w", err)
	}

	o.logger.Info("team updated", "slug", slug)
	return team, nil
}

// --- TaskCoordinator ---

// DispatchTask validates the target agent via OrgChart, ensures the container is
// running, and dispatches the task via WS. Files are copied with path containment.
func (o *GoOrchestratorImpl) DispatchTask(ctx context.Context, task *domain.Task) error {
	if task.AgentAID == "" {
		return &domain.ValidationError{Field: "agent_aid", Message: "agent_aid is required"}
	}
	if task.Prompt == "" {
		return &domain.ValidationError{Field: "prompt", Message: "prompt is required"}
	}

	// Validate target agent exists in OrgChart.
	targetAgent, err := o.orgChart.GetAgentByAID(task.AgentAID)
	if err != nil {
		return &domain.NotFoundError{Resource: "agent", ID: task.AgentAID}
	}

	// Resolve team for target agent.
	targetTeam, err := o.orgChart.GetTeamForAgent(task.AgentAID)
	if err != nil {
		return &domain.ValidationError{
			Field:   "agent_aid",
			Message: fmt.Sprintf("agent %s is not in any team", task.AgentAID),
		}
	}
	_ = targetAgent // AID resolved; used for validation.

	// Set task fields.
	if task.ID == "" {
		task.ID = uuid.NewString()
	}
	now := time.Now()
	if task.CreatedAt.IsZero() {
		task.CreatedAt = now
	}
	task.UpdatedAt = now
	task.TeamSlug = targetTeam.Slug
	task.Status = domain.TaskStatusPending

	// Persist task.
	if err := o.taskStore.Create(ctx, task); err != nil {
		return fmt.Errorf("failed to create task: %w", err)
	}

	// Ensure container is running.
	if o.containerManager != nil {
		if err := o.containerManager.EnsureRunning(ctx, targetTeam.Slug); err != nil {
			o.logger.Warn("failed to ensure container running",
				"task_id", task.ID,
				"team", targetTeam.Slug,
				"error", err,
			)
			// Task persisted; container may come online later.
			return nil
		}
	}

	// Dispatch via WS.
	dispatchMsg := ws.TaskDispatchMsg{
		TaskID:   task.ID,
		AgentAID: task.AgentAID,
		Prompt:   task.Prompt,
	}
	encoded, err := ws.EncodeMessage(ws.MsgTypeTaskDispatch, dispatchMsg)
	if err != nil {
		return fmt.Errorf("failed to encode task dispatch: %w", err)
	}

	if err := o.wsHub.SendToTeam(targetTeam.Slug, encoded); err != nil {
		o.logger.Warn("failed to dispatch task to container",
			"task_id", task.ID,
			"team", targetTeam.Slug,
			"error", err,
		)
		return nil // Task persisted; can be retried.
	}

	// Mark as running.
	task.Status = domain.TaskStatusRunning
	task.UpdatedAt = time.Now()
	if updateErr := o.taskStore.Update(ctx, task); updateErr != nil {
		o.logger.Error("failed to update task status to running",
			"task_id", task.ID,
			"error", updateErr,
		)
	}

	// Publish event.
	if o.eventBus != nil {
		o.eventBus.Publish(domain.Event{
			Type:    domain.EventTypeTaskCreated,
			Payload: task,
		})
	}

	o.logger.Info("task dispatched",
		"task_id", task.ID,
		"team", targetTeam.Slug,
		"agent", task.AgentAID,
	)
	return nil
}

// HandleTaskResult processes a task result: stores it, checks if all sibling
// subtasks are complete, and triggers consolidation if so.
func (o *GoOrchestratorImpl) HandleTaskResult(ctx context.Context, taskID string, result string, errMsg string) error {
	task, err := o.taskStore.Get(ctx, taskID)
	if err != nil {
		return fmt.Errorf("task not found: %w", err)
	}

	now := time.Now()
	task.UpdatedAt = now
	task.CompletedAt = &now

	if errMsg != "" {
		task.Status = domain.TaskStatusFailed
		task.Error = errMsg
	} else {
		task.Status = domain.TaskStatusCompleted
		task.Result = result
	}

	if err := o.taskStore.Update(ctx, task); err != nil {
		return fmt.Errorf("failed to update task result: %w", err)
	}

	// Publish event.
	if o.eventBus != nil {
		eventType := domain.EventTypeTaskCompleted
		if task.Status == domain.TaskStatusFailed {
			eventType = domain.EventTypeTaskFailed
		}
		o.eventBus.Publish(domain.Event{
			Type:    eventType,
			Payload: task,
		})
	}

	// If this task has a parent, check if all sibling subtasks are complete.
	if task.ParentID != "" {
		if consolidateErr := o.checkAndConsolidateSubtasks(ctx, task.ParentID); consolidateErr != nil {
			o.logger.Error("failed to consolidate subtasks",
				"parent_task_id", task.ParentID,
				"error", consolidateErr,
			)
		}
	}

	o.logger.Info("task result processed",
		"task_id", taskID,
		"status", task.Status,
	)
	return nil
}

// checkAndConsolidateSubtasks checks if all subtasks of parentID are terminal,
// and if so, updates the parent task with consolidated results.
func (o *GoOrchestratorImpl) checkAndConsolidateSubtasks(ctx context.Context, parentID string) error {
	subtasks, err := o.taskStore.GetSubtree(ctx, parentID)
	if err != nil {
		return fmt.Errorf("failed to get subtask tree: %w", err)
	}

	// Filter to direct children only (tasks whose ParentID == parentID).
	var children []*domain.Task
	for _, t := range subtasks {
		if t.ParentID == parentID {
			children = append(children, t)
		}
	}

	if len(children) == 0 {
		return nil
	}

	// Check if all children are terminal.
	allDone := true
	for _, child := range children {
		if child.Status == domain.TaskStatusPending || child.Status == domain.TaskStatusRunning {
			allDone = false
			break
		}
	}

	if !allDone {
		return nil
	}

	// All subtasks are terminal — consolidate results.
	var results []string
	anyFailed := false
	for _, child := range children {
		if child.Status == domain.TaskStatusCompleted && child.Result != "" {
			shortID := child.ID
			if len(shortID) > 8 {
				shortID = shortID[:8]
			}
			results = append(results, fmt.Sprintf("[%s] %s", shortID, child.Result))
		} else if child.Status == domain.TaskStatusFailed {
			anyFailed = true
		}
	}

	// Load parent task and update with consolidated result.
	parent, err := o.taskStore.Get(ctx, parentID)
	if err != nil {
		return fmt.Errorf("failed to get parent task: %w", err)
	}

	now := time.Now()
	parent.UpdatedAt = now
	parent.CompletedAt = &now

	if anyFailed && len(results) == 0 {
		parent.Status = domain.TaskStatusFailed
		parent.Error = "one or more subtasks failed"
	} else {
		parent.Status = domain.TaskStatusCompleted
		parent.Result = strings.Join(results, "\n---\n")
	}

	if err := o.taskStore.Update(ctx, parent); err != nil {
		return fmt.Errorf("failed to update parent task with consolidated result: %w", err)
	}

	if o.eventBus != nil {
		eventType := domain.EventTypeTaskCompleted
		if parent.Status == domain.TaskStatusFailed {
			eventType = domain.EventTypeTaskFailed
		}
		o.eventBus.Publish(domain.Event{
			Type:    eventType,
			Payload: parent,
		})
	}

	o.logger.Info("subtask results consolidated",
		"parent_task_id", parentID,
		"subtask_count", len(children),
		"consolidated_status", parent.Status,
	)
	return nil
}

// CancelTask updates the task status to cancelled and sends a shutdown signal.
func (o *GoOrchestratorImpl) CancelTask(ctx context.Context, taskID string) error {
	task, err := o.taskStore.Get(ctx, taskID)
	if err != nil {
		return fmt.Errorf("task not found: %w", err)
	}

	if task.Status == domain.TaskStatusCompleted || task.Status == domain.TaskStatusFailed || task.Status == domain.TaskStatusCancelled {
		return &domain.ValidationError{
			Field:   "task_id",
			Message: fmt.Sprintf("task %s is already %s", taskID, task.Status),
		}
	}

	now := time.Now()
	task.Status = domain.TaskStatusCancelled
	task.UpdatedAt = now
	task.CompletedAt = &now

	if err := o.taskStore.Update(ctx, task); err != nil {
		return fmt.Errorf("failed to update task: %w", err)
	}

	// Send cancel signal to container.
	if task.TeamSlug != "" {
		cancelMsg := ws.ShutdownMsg{
			Reason:  fmt.Sprintf("task %s cancelled", taskID),
			Timeout: 5,
		}
		encoded, encErr := ws.EncodeMessage(ws.MsgTypeShutdown, cancelMsg)
		if encErr == nil {
			if sendErr := o.wsHub.SendToTeam(task.TeamSlug, encoded); sendErr != nil {
				o.logger.Warn("failed to send cancel to container",
					"task_id", taskID,
					"team", task.TeamSlug,
					"error", sendErr,
				)
			}
		}
	}

	if o.eventBus != nil {
		o.eventBus.Publish(domain.Event{
			Type:    domain.EventTypeTaskCancelled,
			Payload: task,
		})
	}

	o.logger.Info("task cancelled", "task_id", taskID)
	return nil
}

// GetTaskStatus returns the current task from the store.
func (o *GoOrchestratorImpl) GetTaskStatus(ctx context.Context, taskID string) (*domain.Task, error) {
	return o.taskStore.Get(ctx, taskID)
}

// CreateSubtasks creates subtasks for the given parent and dispatches each.
func (o *GoOrchestratorImpl) CreateSubtasks(ctx context.Context, parentID string, prompts []string, teamSlug string) ([]*domain.Task, error) {
	if parentID == "" {
		return nil, &domain.ValidationError{Field: "parent_id", Message: "parent_id is required"}
	}
	if len(prompts) == 0 {
		return nil, &domain.ValidationError{Field: "prompts", Message: "at least one prompt is required"}
	}
	if err := domain.ValidateSlug(teamSlug); err != nil {
		return nil, err
	}

	// Verify parent exists.
	parent, err := o.taskStore.Get(ctx, parentID)
	if err != nil {
		return nil, fmt.Errorf("parent task not found: %w", err)
	}

	// Resolve team leader as default dispatch target.
	team, err := o.orgChart.GetTeamBySlug(teamSlug)
	if err != nil {
		return nil, &domain.NotFoundError{Resource: "team", ID: teamSlug}
	}

	tasks := make([]*domain.Task, 0, len(prompts))
	for i, prompt := range prompts {
		now := time.Now()
		task := &domain.Task{
			ID:        uuid.NewString(),
			ParentID:  parent.ID,
			TeamSlug:  teamSlug,
			AgentAID:  team.LeaderAID,
			Status:    domain.TaskStatusPending,
			Prompt:    prompt,
			CreatedAt: now,
			UpdatedAt: now,
		}

		if err := o.DispatchTask(ctx, task); err != nil {
			o.logger.Error("failed to dispatch subtask",
				"parent_id", parentID,
				"index", i,
				"error", err,
			)
			// Continue — persist failures shouldn't abort the others.
			continue
		}
		tasks = append(tasks, task)
	}

	o.logger.Info("subtasks created",
		"parent_id", parentID,
		"requested", len(prompts),
		"dispatched", len(tasks),
	)
	return tasks, nil
}

// --- HealthManager ---

// GetHealthStatus returns the latest heartbeat status for a team.
func (o *GoOrchestratorImpl) GetHealthStatus(teamSlug string) (*domain.HeartbeatStatus, error) {
	if o.heartbeatMonitor == nil {
		return nil, &domain.NotFoundError{Resource: "heartbeat_status", ID: teamSlug}
	}
	return o.heartbeatMonitor.GetStatus(teamSlug)
}

// HandleUnhealthy triggers a container restart when a team becomes unhealthy.
func (o *GoOrchestratorImpl) HandleUnhealthy(ctx context.Context, teamID string) error {
	o.logger.Warn("handling unhealthy team", "team_id", teamID)

	if o.containerManager == nil {
		o.logger.Warn("no container manager configured, cannot restart team", "team_id", teamID)
		return nil
	}

	if err := o.containerManager.RestartTeam(ctx, teamID); err != nil {
		return fmt.Errorf("failed to restart unhealthy team %s: %w", teamID, err)
	}

	o.logger.Info("unhealthy team restarted", "team_id", teamID)

	if o.eventBus != nil {
		o.eventBus.Publish(domain.Event{
			Type: domain.EventTypeContainerStateChanged,
			Payload: map[string]string{
				"team_id": teamID,
				"state":   "restarting",
			},
		})
	}
	return nil
}

// GetAllStatuses returns all team heartbeat statuses.
func (o *GoOrchestratorImpl) GetAllStatuses() map[string]*domain.HeartbeatStatus {
	if o.heartbeatMonitor == nil {
		return make(map[string]*domain.HeartbeatStatus)
	}
	return o.heartbeatMonitor.GetAllStatuses()
}

// --- File copy (used by DispatchTask helpers) ---

// CopyFileWithContainment copies a file between workspace paths, enforcing that
// both source and destination are within their respective workspace roots.
// Returns an error if path traversal is detected.
func CopyFileWithContainment(srcRoot, destRoot, relPath string, logger *slog.Logger) error {
	// Sanitize relPath: reject any ".." components.
	if strings.Contains(relPath, "..") {
		return fmt.Errorf("path traversal rejected: %q contains '..'", relPath)
	}
	if filepath.IsAbs(relPath) {
		return fmt.Errorf("path traversal rejected: absolute path not allowed: %q", relPath)
	}

	srcAbs := filepath.Join(srcRoot, relPath)
	destAbs := filepath.Join(destRoot, relPath)

	// Validate containment: resolved path must be under the declared root.
	cleanSrc, err := filepath.Abs(srcAbs)
	if err != nil {
		return fmt.Errorf("failed to resolve source path: %w", err)
	}
	cleanDest, err := filepath.Abs(destAbs)
	if err != nil {
		return fmt.Errorf("failed to resolve destination path: %w", err)
	}

	cleanSrcRoot, err := filepath.Abs(srcRoot)
	if err != nil {
		return fmt.Errorf("failed to resolve source root: %w", err)
	}
	cleanDestRoot, err := filepath.Abs(destRoot)
	if err != nil {
		return fmt.Errorf("failed to resolve destination root: %w", err)
	}

	if !strings.HasPrefix(cleanSrc+string(filepath.Separator), cleanSrcRoot+string(filepath.Separator)) {
		return fmt.Errorf("path containment violation: source %q escapes root %q", cleanSrc, cleanSrcRoot)
	}
	if !strings.HasPrefix(cleanDest+string(filepath.Separator), cleanDestRoot+string(filepath.Separator)) {
		return fmt.Errorf("path containment violation: destination %q escapes root %q", cleanDest, cleanDestRoot)
	}

	// Ensure destination directory exists.
	if err := os.MkdirAll(filepath.Dir(cleanDest), 0750); err != nil {
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	// Perform copy.
	srcFile, err := os.Open(cleanSrc)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}
	defer srcFile.Close()

	destFile, err := os.OpenFile(cleanDest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("failed to open destination file: %w", err)
	}
	defer destFile.Close()

	written, err := io.Copy(destFile, srcFile)
	if err != nil {
		return fmt.Errorf("failed to copy file: %w", err)
	}

	if logger != nil {
		logger.Info("file copied",
			"src", cleanSrc,
			"dest", cleanDest,
			"bytes", written,
		)
	}
	return nil
}

// --- helpers ---

// rebuildOrgChart reloads all configs and rebuilds the in-memory OrgChart.
func (o *GoOrchestratorImpl) rebuildOrgChart() error {
	master := o.configLoader.GetMaster()
	if master == nil {
		var err error
		master, err = o.configLoader.LoadMaster()
		if err != nil {
			return fmt.Errorf("failed to load master config: %w", err)
		}
	}

	slugs, err := o.configLoader.ListTeams()
	if err != nil {
		return fmt.Errorf("failed to list teams: %w", err)
	}

	teams := make(map[string]*domain.Team, len(slugs))
	for _, slug := range slugs {
		team, err := o.configLoader.LoadTeam(slug)
		if err != nil {
			o.logger.Warn("failed to load team during orgchart rebuild", "slug", slug, "error", err)
			continue
		}
		teams[slug] = team
	}

	return o.orgChart.RebuildFromConfig(master, teams)
}

// minInt returns the smaller of two ints.
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
