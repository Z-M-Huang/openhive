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

// Dispatcher handles task creation and dispatch to team containers via WebSocket.
type Dispatcher struct {
	taskStore domain.TaskStore
	wsHub     domain.WSHub
	logger    *slog.Logger
}

// NewDispatcher creates a new task dispatcher.
func NewDispatcher(taskStore domain.TaskStore, wsHub domain.WSHub, logger *slog.Logger) *Dispatcher {
	return &Dispatcher{
		taskStore: taskStore,
		wsHub:     wsHub,
		logger:    logger,
	}
}

// CreateAndDispatch creates a task in the database and dispatches it to the
// target team's container via WebSocket.
func (d *Dispatcher) CreateAndDispatch(ctx context.Context, teamSlug string, agentAID string, prompt string, parentID string) (*domain.Task, error) {
	now := time.Now()
	task := &domain.Task{
		ID:        uuid.NewString(),
		ParentID:  parentID,
		TeamSlug:  teamSlug,
		AgentAID:  agentAID,
		Status:    domain.TaskStatusPending,
		Prompt:    prompt,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := d.taskStore.Create(ctx, task); err != nil {
		return nil, fmt.Errorf("failed to create task: %w", err)
	}

	// Build task dispatch message
	dispatchMsg := ws.TaskDispatchMsg{
		TaskID:   task.ID,
		AgentAID: agentAID,
		Prompt:   prompt,
	}

	encoded, err := ws.EncodeMessage(ws.MsgTypeTaskDispatch, dispatchMsg)
	if err != nil {
		return task, fmt.Errorf("failed to encode task dispatch: %w", err)
	}

	// Send to team container
	teamID := teamSlug // In production, this would be resolved via TID
	if err := d.wsHub.SendToTeam(teamID, encoded); err != nil {
		d.logger.Warn("failed to dispatch task to container",
			"task_id", task.ID,
			"team", teamSlug,
			"error", err,
		)
		// Task is persisted, can be retried when container connects
		return task, nil
	}

	// Update task status to running
	task.Status = domain.TaskStatusRunning
	task.UpdatedAt = time.Now()
	if err := d.taskStore.Update(ctx, task); err != nil {
		d.logger.Error("failed to update task status", "task_id", task.ID, "error", err)
	}

	d.logger.Info("task dispatched",
		"task_id", task.ID,
		"team", teamSlug,
		"agent", agentAID,
	)

	return task, nil
}

// HandleResult processes a task result received from a container.
func (d *Dispatcher) HandleResult(ctx context.Context, result *ws.TaskResultMsg) error {
	task, err := d.taskStore.Get(ctx, result.TaskID)
	if err != nil {
		return fmt.Errorf("task not found: %w", err)
	}

	now := time.Now()
	task.UpdatedAt = now
	task.CompletedAt = &now

	switch result.Status {
	case "completed":
		task.Status = domain.TaskStatusCompleted
		task.Result = result.Result
	case "failed":
		task.Status = domain.TaskStatusFailed
		task.Error = result.Error
	default:
		return &domain.ValidationError{
			Field:   "status",
			Message: fmt.Sprintf("unexpected task result status: %s", result.Status),
		}
	}

	if err := d.taskStore.Update(ctx, task); err != nil {
		return fmt.Errorf("failed to update task: %w", err)
	}

	d.logger.Info("task result processed",
		"task_id", result.TaskID,
		"status", result.Status,
		"duration", result.Duration,
	)

	return nil
}

// HandleWSMessage processes an incoming WebSocket message from a container.
// Routes task_result and tool_call messages appropriately.
func (d *Dispatcher) HandleWSMessage(teamID string, data []byte) {
	msgType, payload, err := ws.ParseMessage(data)
	if err != nil {
		d.logger.Error("failed to parse WS message", "team_id", teamID, "error", err)
		return
	}

	switch msgType {
	case ws.MsgTypeTaskResult:
		result, ok := payload.(*ws.TaskResultMsg)
		if !ok {
			d.logger.Error("invalid task_result payload type", "team_id", teamID)
			return
		}
		if handleErr := d.HandleResult(context.Background(), result); handleErr != nil {
			d.logger.Error("failed to handle task result", "task_id", result.TaskID, "error", handleErr)
		}

	case ws.MsgTypeReady:
		ready, ok := payload.(*ws.ReadyMsg)
		if !ok {
			d.logger.Error("invalid ready payload type", "team_id", teamID)
			return
		}
		d.logger.Info("container ready", "team_id", ready.TeamID, "agent_count", ready.AgentCount)

	case ws.MsgTypeHeartbeat:
		// Heartbeat processing will be handled by the HeartbeatMonitor
		d.logger.Debug("heartbeat received", "team_id", teamID)

	case ws.MsgTypeToolCall:
		// Tool calls will be handled by the SDKToolHandler (Issue #16)
		toolCall, ok := payload.(*ws.ToolCallMsg)
		if !ok {
			d.logger.Error("invalid tool_call payload type", "team_id", teamID)
			return
		}
		d.logger.Info("tool call received (handler not yet wired)",
			"team_id", teamID,
			"call_id", toolCall.CallID,
			"tool_name", toolCall.ToolName,
		)

	case ws.MsgTypeEscalation:
		escalation, ok := payload.(*ws.EscalationMsg)
		if !ok {
			d.logger.Error("invalid escalation payload type", "team_id", teamID)
			return
		}
		d.logger.Warn("escalation received",
			"task_id", escalation.TaskID,
			"agent", escalation.AgentAID,
			"reason", escalation.Reason,
		)

	case ws.MsgTypeStatusUpdate:
		d.logger.Info("status update received", "team_id", teamID)

	default:
		d.logger.Warn("unhandled message type", "type", msgType, "team_id", teamID)
	}
}

// SendContainerInit sends a container_init message to a team container.
func (d *Dispatcher) SendContainerInit(teamID string, isMain bool, agents []ws.AgentInitConfig, secrets map[string]string) error {
	initMsg := ws.ContainerInitMsg{
		IsMainAssistant: isMain,
		TeamConfig:      json.RawMessage(`{}`),
		Agents:          agents,
		Secrets:         secrets,
	}

	encoded, err := ws.EncodeMessage(ws.MsgTypeContainerInit, initMsg)
	if err != nil {
		return fmt.Errorf("failed to encode container_init: %w", err)
	}

	return d.wsHub.SendToTeam(teamID, encoded)
}
