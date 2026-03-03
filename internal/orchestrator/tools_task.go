package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/ws"
	"github.com/google/uuid"
)

// TaskToolsDeps holds dependencies for task management tool handlers.
type TaskToolsDeps struct {
	TaskStore        domain.TaskStore
	WSHub            domain.WSHub
	ContainerManager domain.ContainerManager
	OrgChart         domain.OrgChart
	Logger           *slog.Logger
}

// RegisterTaskTools registers all task management SDK tool handlers on the ToolHandler.
func RegisterTaskTools(handler *ToolHandler, deps TaskToolsDeps) {
	handler.Register("dispatch_subtask", makeDispatchSubtask(deps))
	handler.Register("get_task_status", makeGetTaskStatus(deps))
	handler.Register("cancel_task", makeCancelTask(deps))
	handler.Register("list_tasks", makeListTasks(deps))
	handler.Register("get_member_status", makeGetMemberStatus(deps))
}

// --- dispatch_subtask ---

type dispatchSubtaskArgs struct {
	AgentAID     string `json:"agent_aid"`
	Prompt       string `json:"prompt"`
	ParentTaskID string `json:"parent_task_id,omitempty"`
	// CallerTeamSlug is the team slug of the calling agent (provided by dispatcher context).
	// It's used to enforce hierarchy validation.
	CallerTeamSlug string `json:"caller_team_slug,omitempty"`
}

func makeDispatchSubtask(deps TaskToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a dispatchSubtaskArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if err := domain.ValidateAID(a.AgentAID); err != nil {
			return nil, err
		}
		if a.Prompt == "" {
			return nil, &domain.ValidationError{Field: "prompt", Message: "prompt is required"}
		}

		// Verify target agent exists
		targetAgent, err := deps.OrgChart.GetAgentByAID(a.AgentAID)
		if err != nil {
			return nil, &domain.NotFoundError{Resource: "agent", ID: a.AgentAID}
		}

		// Resolve team for the target agent
		targetTeam, err := deps.OrgChart.GetTeamForAgent(a.AgentAID)
		if err != nil {
			return nil, &domain.ValidationError{
				Field:   "agent_aid",
				Message: fmt.Sprintf("agent %s is not in any team", a.AgentAID),
			}
		}

		// Ensure container is running
		ctx := context.Background()
		if deps.ContainerManager != nil {
			if ensureErr := deps.ContainerManager.EnsureRunning(ctx, targetTeam.Slug); ensureErr != nil {
				return nil, fmt.Errorf("failed to ensure container running for team %s: %w", targetTeam.Slug, ensureErr)
			}
		}

		// Create task
		now := time.Now()
		task := &domain.Task{
			ID:        uuid.NewString(),
			ParentID:  a.ParentTaskID,
			TeamSlug:  targetTeam.Slug,
			AgentAID:  targetAgent.AID,
			Status:    domain.TaskStatusPending,
			Prompt:    a.Prompt,
			CreatedAt: now,
			UpdatedAt: now,
		}

		if err := deps.TaskStore.Create(ctx, task); err != nil {
			return nil, fmt.Errorf("failed to create task: %w", err)
		}

		// Dispatch via WSHub
		dispatchMsg := ws.TaskDispatchMsg{
			TaskID:   task.ID,
			AgentAID: a.AgentAID,
			Prompt:   a.Prompt,
		}
		encoded, err := ws.EncodeMessage(ws.MsgTypeTaskDispatch, dispatchMsg)
		if err != nil {
			return nil, fmt.Errorf("failed to encode task dispatch: %w", err)
		}

		if sendErr := deps.WSHub.SendToTeam(targetTeam.Slug, encoded); sendErr != nil {
			deps.Logger.Warn("failed to dispatch task to container",
				"task_id", task.ID,
				"team", targetTeam.Slug,
				"error", sendErr,
			)
			// Task is persisted; can be retried when container reconnects
		} else {
			// Mark as running
			task.Status = domain.TaskStatusRunning
			task.UpdatedAt = time.Now()
			if updateErr := deps.TaskStore.Update(ctx, task); updateErr != nil {
				deps.Logger.Error("failed to update task status", "task_id", task.ID, "error", updateErr)
			}
		}

		deps.Logger.Info("subtask dispatched",
			"task_id", task.ID,
			"team", targetTeam.Slug,
			"agent", a.AgentAID,
		)

		return json.Marshal(map[string]string{
			"task_id": task.ID,
			"status":  task.Status.String(),
		})
	}
}

// --- get_task_status ---

type getTaskStatusArgs struct {
	TaskID string `json:"task_id"`
}

func makeGetTaskStatus(deps TaskToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a getTaskStatusArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if a.TaskID == "" {
			return nil, &domain.ValidationError{Field: "task_id", Message: "task_id is required"}
		}

		ctx := context.Background()
		task, err := deps.TaskStore.Get(ctx, a.TaskID)
		if err != nil {
			return nil, err
		}

		return json.Marshal(task)
	}
}

// --- cancel_task ---

type cancelTaskArgs struct {
	TaskID string `json:"task_id"`
}

func makeCancelTask(deps TaskToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a cancelTaskArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if a.TaskID == "" {
			return nil, &domain.ValidationError{Field: "task_id", Message: "task_id is required"}
		}

		ctx := context.Background()
		task, err := deps.TaskStore.Get(ctx, a.TaskID)
		if err != nil {
			return nil, err
		}

		// Only pending/running tasks can be cancelled
		if task.Status == domain.TaskStatusCompleted || task.Status == domain.TaskStatusFailed {
			return nil, &domain.ValidationError{
				Field:   "task_id",
				Message: fmt.Sprintf("task %s is already %s", a.TaskID, task.Status),
			}
		}

		// Update status to cancelled
		now := time.Now()
		task.Status = domain.TaskStatusCancelled
		task.UpdatedAt = now
		task.CompletedAt = &now
		if err := deps.TaskStore.Update(ctx, task); err != nil {
			return nil, fmt.Errorf("failed to update task: %w", err)
		}

		// Send cancel signal to container if task is running
		if task.TeamSlug != "" {
			cancelMsg := ws.ShutdownMsg{
				Reason:  fmt.Sprintf("task %s cancelled", a.TaskID),
				Timeout: 5,
			}
			encoded, encErr := ws.EncodeMessage(ws.MsgTypeShutdown, cancelMsg)
			if encErr == nil {
				if sendErr := deps.WSHub.SendToTeam(task.TeamSlug, encoded); sendErr != nil {
					deps.Logger.Warn("failed to send cancel to container",
						"task_id", a.TaskID,
						"team", task.TeamSlug,
						"error", sendErr,
					)
				}
			}
		}

		deps.Logger.Info("task cancelled", "task_id", a.TaskID)

		return json.Marshal(map[string]string{
			"task_id": a.TaskID,
			"status":  "cancelled",
		})
	}
}

// --- list_tasks ---

type listTasksArgs struct {
	TeamSlug string `json:"team_slug,omitempty"`
	Status   string `json:"status,omitempty"`
	Limit    int    `json:"limit,omitempty"`
}

func makeListTasks(deps TaskToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a listTasksArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		ctx := context.Background()
		var tasks []*domain.Task
		var listErr error

		if a.TeamSlug != "" {
			if err := domain.ValidateSlug(a.TeamSlug); err != nil {
				return nil, err
			}
			tasks, listErr = deps.TaskStore.ListByTeam(ctx, a.TeamSlug)
		} else if a.Status != "" {
			status, parseErr := domain.ParseTaskStatus(a.Status)
			if parseErr != nil {
				return nil, &domain.ValidationError{Field: "status", Message: fmt.Sprintf("invalid status: %s", a.Status)}
			}
			tasks, listErr = deps.TaskStore.ListByStatus(ctx, status)
		} else {
			// Default: list running tasks
			tasks, listErr = deps.TaskStore.ListByStatus(ctx, domain.TaskStatusRunning)
		}

		if listErr != nil {
			return nil, fmt.Errorf("failed to list tasks: %w", listErr)
		}

		// Apply limit
		if a.Limit > 0 && len(tasks) > a.Limit {
			tasks = tasks[:a.Limit]
		}

		return json.Marshal(tasks)
	}
}

// --- get_member_status ---

type getMemberStatusArgs struct {
	AgentAID string `json:"agent_aid,omitempty"`
	TeamSlug string `json:"team_slug,omitempty"`
}

func makeGetMemberStatus(deps TaskToolsDeps) ToolFunc {
	return func(args json.RawMessage) (json.RawMessage, error) {
		var a getMemberStatusArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, &domain.ValidationError{Field: "args", Message: "invalid arguments"}
		}

		if a.AgentAID == "" && a.TeamSlug == "" {
			return nil, &domain.ValidationError{
				Field:   "args",
				Message: "either agent_aid or team_slug is required",
			}
		}

		if a.AgentAID != "" {
			if err := domain.ValidateAID(a.AgentAID); err != nil {
				return nil, err
			}
			agent, err := deps.OrgChart.GetAgentByAID(a.AgentAID)
			if err != nil {
				return nil, err
			}
			return json.Marshal(agent)
		}

		// team_slug query
		if err := domain.ValidateSlug(a.TeamSlug); err != nil {
			return nil, err
		}
		team, err := deps.OrgChart.GetTeamBySlug(a.TeamSlug)
		if err != nil {
			return nil, err
		}
		return json.Marshal(team)
	}
}
