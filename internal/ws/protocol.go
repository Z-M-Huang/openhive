package ws

import (
	"encoding/json"
	"fmt"
	"regexp"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// goToContainerTypes are message types that Go sends to containers.
var goToContainerTypes = map[string]bool{
	MsgTypeContainerInit: true,
	MsgTypeTaskDispatch:  true,
	MsgTypeShutdown:      true,
	MsgTypeToolResult:    true,
}

// containerToGoTypes are message types that containers send to Go.
var containerToGoTypes = map[string]bool{
	MsgTypeReady:        true,
	MsgTypeHeartbeat:    true,
	MsgTypeTaskResult:   true,
	MsgTypeEscalation:   true,
	MsgTypeToolCall:     true,
	MsgTypeStatusUpdate: true,
}

// ParseMessage deserializes a raw WebSocket message into its typed payload.
// Returns the message type, the typed payload, and any error.
func ParseMessage(data []byte) (string, interface{}, error) {
	var env WSMessage
	if err := json.Unmarshal(data, &env); err != nil {
		return "", nil, fmt.Errorf("invalid message envelope: %w", err)
	}

	if env.Type == "" {
		return "", nil, &domain.ValidationError{Field: "type", Message: "message type is required"}
	}

	switch env.Type {
	case MsgTypeContainerInit:
		var msg ContainerInitMsg
		if err := json.Unmarshal(env.Data, &msg); err != nil {
			return env.Type, nil, fmt.Errorf("invalid %s data: %w", env.Type, err)
		}
		return env.Type, &msg, nil

	case MsgTypeTaskDispatch:
		var msg TaskDispatchMsg
		if err := json.Unmarshal(env.Data, &msg); err != nil {
			return env.Type, nil, fmt.Errorf("invalid %s data: %w", env.Type, err)
		}
		if msg.TaskID == "" {
			return env.Type, nil, &domain.ValidationError{Field: "task_id", Message: "task_id is required"}
		}
		if msg.AgentAID == "" {
			return env.Type, nil, &domain.ValidationError{Field: "agent_aid", Message: "agent_aid is required"}
		}
		return env.Type, &msg, nil

	case MsgTypeShutdown:
		var msg ShutdownMsg
		if err := json.Unmarshal(env.Data, &msg); err != nil {
			return env.Type, nil, fmt.Errorf("invalid %s data: %w", env.Type, err)
		}
		return env.Type, &msg, nil

	case MsgTypeToolResult:
		var msg ToolResultMsg
		if err := json.Unmarshal(env.Data, &msg); err != nil {
			return env.Type, nil, fmt.Errorf("invalid %s data: %w", env.Type, err)
		}
		if msg.CallID == "" {
			return env.Type, nil, &domain.ValidationError{Field: "call_id", Message: "call_id is required"}
		}
		return env.Type, &msg, nil

	case MsgTypeReady:
		var msg ReadyMsg
		if err := json.Unmarshal(env.Data, &msg); err != nil {
			return env.Type, nil, fmt.Errorf("invalid %s data: %w", env.Type, err)
		}
		if msg.TeamID == "" {
			return env.Type, nil, &domain.ValidationError{Field: "team_id", Message: "team_id is required"}
		}
		return env.Type, &msg, nil

	case MsgTypeHeartbeat:
		var msg HeartbeatMsg
		if err := json.Unmarshal(env.Data, &msg); err != nil {
			return env.Type, nil, fmt.Errorf("invalid %s data: %w", env.Type, err)
		}
		return env.Type, &msg, nil

	case MsgTypeTaskResult:
		var msg TaskResultMsg
		if err := json.Unmarshal(env.Data, &msg); err != nil {
			return env.Type, nil, fmt.Errorf("invalid %s data: %w", env.Type, err)
		}
		if msg.TaskID == "" {
			return env.Type, nil, &domain.ValidationError{Field: "task_id", Message: "task_id is required"}
		}
		return env.Type, &msg, nil

	case MsgTypeEscalation:
		var msg EscalationMsg
		if err := json.Unmarshal(env.Data, &msg); err != nil {
			return env.Type, nil, fmt.Errorf("invalid %s data: %w", env.Type, err)
		}
		if msg.TaskID == "" {
			return env.Type, nil, &domain.ValidationError{Field: "task_id", Message: "task_id is required"}
		}
		return env.Type, &msg, nil

	case MsgTypeToolCall:
		var msg ToolCallMsg
		if err := json.Unmarshal(env.Data, &msg); err != nil {
			return env.Type, nil, fmt.Errorf("invalid %s data: %w", env.Type, err)
		}
		if msg.CallID == "" {
			return env.Type, nil, &domain.ValidationError{Field: "call_id", Message: "call_id is required"}
		}
		if msg.ToolName == "" {
			return env.Type, nil, &domain.ValidationError{Field: "tool_name", Message: "tool_name is required"}
		}
		return env.Type, &msg, nil

	case MsgTypeStatusUpdate:
		var msg StatusUpdateMsg
		if err := json.Unmarshal(env.Data, &msg); err != nil {
			return env.Type, nil, fmt.Errorf("invalid %s data: %w", env.Type, err)
		}
		if msg.AgentAID == "" {
			return env.Type, nil, &domain.ValidationError{Field: "agent_aid", Message: "agent_aid is required"}
		}
		return env.Type, &msg, nil

	default:
		return env.Type, nil, fmt.Errorf("unknown message type: %s", env.Type)
	}
}

// ValidateDirection enforces that containers cannot send Go-to-container types
// and vice versa.
func ValidateDirection(msgType string, isFromContainer bool) error {
	if isFromContainer {
		if goToContainerTypes[msgType] {
			return fmt.Errorf("container cannot send message type %q (Go-to-container only)", msgType)
		}
		if !containerToGoTypes[msgType] {
			return fmt.Errorf("unknown container-to-Go message type: %s", msgType)
		}
	} else {
		if containerToGoTypes[msgType] {
			return fmt.Errorf("Go cannot send message type %q (container-to-Go only)", msgType)
		}
		if !goToContainerTypes[msgType] {
			return fmt.Errorf("unknown Go-to-container message type: %s", msgType)
		}
	}
	return nil
}

// MapDomainErrorToWSError maps domain errors to WS error codes and sanitized messages.
func MapDomainErrorToWSError(err error) (string, string) {
	switch e := err.(type) {
	case *domain.NotFoundError:
		return WSErrorNotFound, e.Error()
	case *domain.ValidationError:
		return WSErrorValidation, e.Error()
	case *domain.ConflictError:
		return WSErrorConflict, e.Error()
	case *domain.EncryptionLockedError:
		return WSErrorEncryptionLocked, e.Error()
	default:
		return WSErrorInternal, SanitizeErrorMessage(err)
	}
}

// pathPattern matches file system paths in error messages
var pathPattern = regexp.MustCompile(`(?:/[a-zA-Z0-9_./-]+)+`)

// stackPattern matches goroutine stack traces
var stackPattern = regexp.MustCompile(`goroutine \d+ \[.*?\]`)

// SanitizeErrorMessage strips file paths, stack traces, and internal details
// from error messages, returning only a safe user-facing message.
func SanitizeErrorMessage(err error) string {
	msg := err.Error()
	msg = pathPattern.ReplaceAllString(msg, "[path]")
	msg = stackPattern.ReplaceAllString(msg, "")
	if msg == "" {
		return "an internal error occurred"
	}
	return msg
}

// EncodeMessage wraps a typed payload into a WSMessage envelope.
func EncodeMessage(msgType string, payload interface{}) ([]byte, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal payload: %w", err)
	}

	env := WSMessage{
		Type: msgType,
		Data: data,
	}

	return json.Marshal(env)
}
