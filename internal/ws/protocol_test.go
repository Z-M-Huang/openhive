package ws

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseMessage_InvalidJSON(t *testing.T) {
	_, _, err := ParseMessage([]byte("not json"))
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "invalid message envelope")
}

func TestParseMessage_MissingType(t *testing.T) {
	_, _, err := ParseMessage([]byte(`{"data":{}}`))
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
	assert.Equal(t, "type", ve.Field)
}

func TestParseMessage_UnknownType(t *testing.T) {
	_, _, err := ParseMessage([]byte(`{"type":"unknown_type","data":{}}`))
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unknown message type")
}

func TestParseMessage_TaskDispatch_MissingTaskID(t *testing.T) {
	data := []byte(`{"type":"task_dispatch","data":{"agent_aid":"aid-001","prompt":"test"}}`)
	_, _, err := ParseMessage(data)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
	assert.Equal(t, "task_id", ve.Field)
}

func TestParseMessage_TaskDispatch_MissingAgentAID(t *testing.T) {
	data := []byte(`{"type":"task_dispatch","data":{"task_id":"task-001","prompt":"test"}}`)
	_, _, err := ParseMessage(data)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
	assert.Equal(t, "agent_aid", ve.Field)
}

func TestParseMessage_ToolResult_MissingCallID(t *testing.T) {
	data := []byte(`{"type":"tool_result","data":{"result":{}}}`)
	_, _, err := ParseMessage(data)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
	assert.Equal(t, "call_id", ve.Field)
}

func TestParseMessage_Ready_MissingTeamID(t *testing.T) {
	data := []byte(`{"type":"ready","data":{"agent_count":3}}`)
	_, _, err := ParseMessage(data)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
	assert.Equal(t, "team_id", ve.Field)
}

func TestParseMessage_TaskResult_MissingTaskID(t *testing.T) {
	data := []byte(`{"type":"task_result","data":{"agent_aid":"aid-001"}}`)
	_, _, err := ParseMessage(data)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
	assert.Equal(t, "task_id", ve.Field)
}

func TestParseMessage_Escalation_MissingTaskID(t *testing.T) {
	data := []byte(`{"type":"escalation","data":{"agent_aid":"aid-001","reason":"stuck"}}`)
	_, _, err := ParseMessage(data)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
	assert.Equal(t, "task_id", ve.Field)
}

func TestParseMessage_ToolCall_MissingCallID(t *testing.T) {
	data := []byte(`{"type":"tool_call","data":{"tool_name":"create_team","arguments":{},"agent_aid":"aid-001"}}`)
	_, _, err := ParseMessage(data)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
	assert.Equal(t, "call_id", ve.Field)
}

func TestParseMessage_ToolCall_MissingToolName(t *testing.T) {
	data := []byte(`{"type":"tool_call","data":{"call_id":"call-001","arguments":{},"agent_aid":"aid-001"}}`)
	_, _, err := ParseMessage(data)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
	assert.Equal(t, "tool_name", ve.Field)
}

func TestParseMessage_StatusUpdate_MissingAgentAID(t *testing.T) {
	data := []byte(`{"type":"status_update","data":{"status":"idle"}}`)
	_, _, err := ParseMessage(data)
	assert.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
	assert.Equal(t, "agent_aid", ve.Field)
}

func TestValidateDirection_ContainerSendingGoType(t *testing.T) {
	err := ValidateDirection(MsgTypeContainerInit, true)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "Go-to-container only")
}

func TestValidateDirection_ContainerSendingReady(t *testing.T) {
	err := ValidateDirection(MsgTypeReady, true)
	assert.NoError(t, err)
}

func TestValidateDirection_GoSendingContainerType(t *testing.T) {
	err := ValidateDirection(MsgTypeHeartbeat, false)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "container-to-Go only")
}

func TestValidateDirection_GoSendingInit(t *testing.T) {
	err := ValidateDirection(MsgTypeContainerInit, false)
	assert.NoError(t, err)
}

func TestValidateDirection_ContainerUnknownType(t *testing.T) {
	err := ValidateDirection("unknown_type", true)
	assert.Error(t, err)
}

func TestValidateDirection_GoUnknownType(t *testing.T) {
	err := ValidateDirection("unknown_type", false)
	assert.Error(t, err)
}

func TestValidateDirection_AllGoToContainerTypes(t *testing.T) {
	for _, msgType := range []string{MsgTypeContainerInit, MsgTypeTaskDispatch, MsgTypeShutdown, MsgTypeToolResult} {
		assert.NoError(t, ValidateDirection(msgType, false), "Go should be able to send %s", msgType)
		assert.Error(t, ValidateDirection(msgType, true), "Container should not send %s", msgType)
	}
}

func TestValidateDirection_AllContainerToGoTypes(t *testing.T) {
	for _, msgType := range []string{MsgTypeReady, MsgTypeHeartbeat, MsgTypeTaskResult, MsgTypeEscalation, MsgTypeToolCall, MsgTypeStatusUpdate} {
		assert.NoError(t, ValidateDirection(msgType, true), "Container should be able to send %s", msgType)
		assert.Error(t, ValidateDirection(msgType, false), "Go should not send %s", msgType)
	}
}

func TestMapDomainErrorToWSError_NotFound(t *testing.T) {
	code, msg := MapDomainErrorToWSError(&domain.NotFoundError{Resource: "team", ID: "my-team"})
	assert.Equal(t, WSErrorNotFound, code)
	assert.Equal(t, "the requested resource was not found", msg)
}

func TestMapDomainErrorToWSError_Validation(t *testing.T) {
	code, msg := MapDomainErrorToWSError(&domain.ValidationError{Field: "name", Message: "too short"})
	assert.Equal(t, WSErrorValidation, code)
	assert.Contains(t, msg, "too short")
}

func TestMapDomainErrorToWSError_Conflict(t *testing.T) {
	code, msg := MapDomainErrorToWSError(&domain.ConflictError{Resource: "team", Message: "already exists"})
	assert.Equal(t, WSErrorConflict, code)
	assert.Equal(t, "a resource conflict occurred", msg)
}

func TestMapDomainErrorToWSError_EncryptionLocked(t *testing.T) {
	code, msg := MapDomainErrorToWSError(&domain.EncryptionLockedError{})
	assert.Equal(t, WSErrorEncryptionLocked, code)
	assert.Equal(t, "encryption is locked", msg)
}

func TestMapDomainErrorToWSError_Unknown(t *testing.T) {
	code, msg := MapDomainErrorToWSError(errors.New("something went wrong in /app/openhive/internal/store/db.go"))
	assert.Equal(t, WSErrorInternal, code)
	assert.NotContains(t, msg, "/app/openhive")
}

func TestSanitizeErrorMessage_StripsFilePaths(t *testing.T) {
	err := errors.New("failed at /home/user/project/internal/store/db.go:42")
	result := SanitizeErrorMessage(err)
	assert.NotContains(t, result, "/home/user")
	assert.Contains(t, result, "[path]")
}

func TestSanitizeErrorMessage_StripsStackTraces(t *testing.T) {
	err := errors.New("panic: goroutine 1 [running] bad thing happened")
	result := SanitizeErrorMessage(err)
	assert.NotContains(t, result, "goroutine 1 [running]")
}

func TestSanitizeErrorMessage_PreservesSimpleMessages(t *testing.T) {
	err := errors.New("connection refused")
	result := SanitizeErrorMessage(err)
	assert.Equal(t, "connection refused", result)
}

func TestEncodeMessage(t *testing.T) {
	data, err := EncodeMessage(MsgTypeReady, &ReadyMsg{TeamID: "tid-001", AgentCount: 2})
	require.NoError(t, err)

	var env WSMessage
	require.NoError(t, unmarshalJSON(data, &env))
	assert.Equal(t, MsgTypeReady, env.Type)
	assert.Contains(t, string(env.Data), "tid-001")
}

func unmarshalJSON(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}

func TestParseMessage_InvalidData(t *testing.T) {
	// Valid envelope but invalid data for the type
	data := []byte(`{"type":"task_dispatch","data":"not an object"}`)
	_, _, err := ParseMessage(data)
	assert.Error(t, err)
}
