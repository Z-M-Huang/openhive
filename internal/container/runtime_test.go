package container

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"testing"
	"time"

	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- mockDockerClient ---

type mockDockerClient struct {
	createFn  func(ctx context.Context, cfg *container.Config, hostCfg *container.HostConfig, netCfg *network.NetworkingConfig, name string) (container.CreateResponse, error)
	startFn   func(ctx context.Context, id string, opts container.StartOptions) error
	stopFn    func(ctx context.Context, id string, opts container.StopOptions) error
	removeFn  func(ctx context.Context, id string, opts container.RemoveOptions) error
	inspectFn func(ctx context.Context, id string) (dockertypes.ContainerJSON, error)
	listFn    func(ctx context.Context, opts container.ListOptions) ([]dockertypes.Container, error)
	netCreateFn func(ctx context.Context, name string, opts network.CreateOptions) (network.CreateResponse, error)
	netInspectFn func(ctx context.Context, id string, opts network.InspectOptions) (network.Inspect, error)
	netListFn func(ctx context.Context, opts network.ListOptions) ([]network.Summary, error)
}

func (m *mockDockerClient) ContainerCreate(ctx context.Context, cfg *container.Config, hc *container.HostConfig, nc *network.NetworkingConfig, name string) (container.CreateResponse, error) {
	if m.createFn != nil {
		return m.createFn(ctx, cfg, hc, nc, name)
	}
	return container.CreateResponse{ID: "mock-container-id"}, nil
}

func (m *mockDockerClient) ContainerStart(ctx context.Context, id string, opts container.StartOptions) error {
	if m.startFn != nil {
		return m.startFn(ctx, id, opts)
	}
	return nil
}

func (m *mockDockerClient) ContainerStop(ctx context.Context, id string, opts container.StopOptions) error {
	if m.stopFn != nil {
		return m.stopFn(ctx, id, opts)
	}
	return nil
}

func (m *mockDockerClient) ContainerRemove(ctx context.Context, id string, opts container.RemoveOptions) error {
	if m.removeFn != nil {
		return m.removeFn(ctx, id, opts)
	}
	return nil
}

func (m *mockDockerClient) ContainerInspect(ctx context.Context, id string) (dockertypes.ContainerJSON, error) {
	if m.inspectFn != nil {
		return m.inspectFn(ctx, id)
	}
	return dockertypes.ContainerJSON{
		ContainerJSONBase: &dockertypes.ContainerJSONBase{
			ID:   id,
			Name: "/openhive-test",
			State: &dockertypes.ContainerState{
				Status:  "running",
				Running: true,
			},
		},
	}, nil
}

func (m *mockDockerClient) ContainerList(ctx context.Context, opts container.ListOptions) ([]dockertypes.Container, error) {
	if m.listFn != nil {
		return m.listFn(ctx, opts)
	}
	return nil, nil
}

func (m *mockDockerClient) NetworkCreate(ctx context.Context, name string, opts network.CreateOptions) (network.CreateResponse, error) {
	if m.netCreateFn != nil {
		return m.netCreateFn(ctx, name, opts)
	}
	return network.CreateResponse{ID: "mock-network-id"}, nil
}

func (m *mockDockerClient) NetworkInspect(ctx context.Context, id string, opts network.InspectOptions) (network.Inspect, error) {
	if m.netInspectFn != nil {
		return m.netInspectFn(ctx, id, opts)
	}
	return network.Inspect{}, nil
}

func (m *mockDockerClient) NetworkList(ctx context.Context, opts network.ListOptions) ([]network.Summary, error) {
	if m.netListFn != nil {
		return m.netListFn(ctx, opts)
	}
	return nil, nil
}

// --- helpers ---

func newTestRuntime(t *testing.T, mock DockerClient) *RuntimeImpl {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelWarn}))
	return NewRuntime(mock, "openhive-team:latest", logger)
}

// --- tests ---

func TestCreateContainer_FullConfig(t *testing.T) {
	var capturedName string
	var capturedCfg *container.Config
	var capturedHostCfg *container.HostConfig
	var capturedNetCfg *network.NetworkingConfig

	mock := &mockDockerClient{
		createFn: func(_ context.Context, cfg *container.Config, hc *container.HostConfig, nc *network.NetworkingConfig, name string) (container.CreateResponse, error) {
			capturedName = name
			capturedCfg = cfg
			capturedHostCfg = hc
			capturedNetCfg = nc
			return container.CreateResponse{ID: "cnt-abc123"}, nil
		},
	}

	rt := newTestRuntime(t, mock)

	id, err := rt.CreateContainer(context.Background(), domain.ContainerConfig{
		Name:      "team-alpha",
		ImageName: "openhive-team:test",
		MaxMemory: "512m",
		Env: map[string]string{
			"WS_URL":   "ws://localhost:8080",
			"WS_TOKEN": "tok-xyz",
		},
	})

	require.NoError(t, err)
	assert.Equal(t, "cnt-abc123", id)
	assert.Equal(t, "openhive-team-alpha", capturedName)
	assert.Equal(t, "openhive-team:test", capturedCfg.Image)
	assert.Equal(t, "openhive", capturedCfg.User)
	assert.Contains(t, capturedCfg.Env, "WS_URL=ws://localhost:8080")
	assert.Contains(t, capturedCfg.Env, "WS_TOKEN=tok-xyz")
	assert.Equal(t, int64(512*1024*1024), capturedHostCfg.Resources.Memory)
	assert.Equal(t, "on-failure", string(capturedHostCfg.RestartPolicy.Name))
	assert.Contains(t, capturedNetCfg.EndpointsConfig, openhiveNetworkName)
}

func TestCreateContainer_DefaultMemoryLimit(t *testing.T) {
	var capturedHostCfg *container.HostConfig

	mock := &mockDockerClient{
		createFn: func(_ context.Context, _ *container.Config, hc *container.HostConfig, _ *network.NetworkingConfig, _ string) (container.CreateResponse, error) {
			capturedHostCfg = hc
			return container.CreateResponse{ID: "cnt-mem-001"}, nil
		},
	}

	rt := newTestRuntime(t, mock)

	_, err := rt.CreateContainer(context.Background(), domain.ContainerConfig{
		Name: "team-default-mem",
		// MaxMemory is empty — should use default 512MB
	})
	require.NoError(t, err)
	assert.Equal(t, defaultMemoryLimit, capturedHostCfg.Resources.Memory)
}

func TestCreateContainer_SetsNonRootUser(t *testing.T) {
	var capturedCfg *container.Config

	mock := &mockDockerClient{
		createFn: func(_ context.Context, cfg *container.Config, _ *container.HostConfig, _ *network.NetworkingConfig, _ string) (container.CreateResponse, error) {
			capturedCfg = cfg
			return container.CreateResponse{ID: "cnt-user-001"}, nil
		},
	}

	rt := newTestRuntime(t, mock)
	_, err := rt.CreateContainer(context.Background(), domain.ContainerConfig{Name: "team-user"})
	require.NoError(t, err)
	assert.Equal(t, containerUser, capturedCfg.User)
}

func TestCreateContainer_MissingName(t *testing.T) {
	rt := newTestRuntime(t, &mockDockerClient{})
	_, err := rt.CreateContainer(context.Background(), domain.ContainerConfig{})
	require.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestStartContainer_DelegatesToClient(t *testing.T) {
	var startedID string
	mock := &mockDockerClient{
		startFn: func(_ context.Context, id string, _ container.StartOptions) error {
			startedID = id
			return nil
		},
	}

	rt := newTestRuntime(t, mock)
	err := rt.StartContainer(context.Background(), "cnt-start-001")
	require.NoError(t, err)
	assert.Equal(t, "cnt-start-001", startedID)
}

func TestStopContainer_WithTimeout(t *testing.T) {
	var capturedTimeout *int
	mock := &mockDockerClient{
		stopFn: func(_ context.Context, _ string, opts container.StopOptions) error {
			capturedTimeout = opts.Timeout
			return nil
		},
	}

	rt := newTestRuntime(t, mock)
	err := rt.StopContainer(context.Background(), "cnt-stop-001", 10*time.Second)
	require.NoError(t, err)
	require.NotNil(t, capturedTimeout)
	assert.Equal(t, 10, *capturedTimeout)
}

func TestRemoveContainer_DelegatesToClient(t *testing.T) {
	var removedID string
	mock := &mockDockerClient{
		removeFn: func(_ context.Context, id string, _ container.RemoveOptions) error {
			removedID = id
			return nil
		},
	}

	rt := newTestRuntime(t, mock)
	err := rt.RemoveContainer(context.Background(), "cnt-remove-001")
	require.NoError(t, err)
	assert.Equal(t, "cnt-remove-001", removedID)
}

func TestInspectContainer_MapsDockerState(t *testing.T) {
	mock := &mockDockerClient{
		inspectFn: func(_ context.Context, id string) (dockertypes.ContainerJSON, error) {
			return dockertypes.ContainerJSON{
				ContainerJSONBase: &dockertypes.ContainerJSONBase{
					ID:   id,
					Name: "/openhive-alpha",
					State: &dockertypes.ContainerState{
						Status:  "running",
						Running: true,
					},
				},
			}, nil
		},
	}

	rt := newTestRuntime(t, mock)
	info, err := rt.InspectContainer(context.Background(), "cnt-inspect-001")
	require.NoError(t, err)
	assert.Equal(t, "cnt-inspect-001", info.ID)
	assert.Equal(t, "openhive-alpha", info.Name) // leading "/" stripped
	assert.Equal(t, domain.ContainerStateRunning, info.State)
}

func TestInspectContainer_StoppedState(t *testing.T) {
	mock := &mockDockerClient{
		inspectFn: func(_ context.Context, id string) (dockertypes.ContainerJSON, error) {
			return dockertypes.ContainerJSON{
				ContainerJSONBase: &dockertypes.ContainerJSONBase{
					ID:   id,
					Name: "/openhive-stopped",
					State: &dockertypes.ContainerState{
						Status:  "exited",
						Running: false,
					},
				},
			}, nil
		},
	}

	rt := newTestRuntime(t, mock)
	info, err := rt.InspectContainer(context.Background(), "cnt-stopped")
	require.NoError(t, err)
	assert.Equal(t, domain.ContainerStateStopped, info.State)
}

func TestListContainers_FiltersByPrefix(t *testing.T) {
	mock := &mockDockerClient{
		listFn: func(_ context.Context, opts container.ListOptions) ([]dockertypes.Container, error) {
			// Verify filter is applied
			assert.True(t, opts.All)
			return []dockertypes.Container{
				{ID: "cnt-aaa", Names: []string{"/openhive-alpha"}, State: "running"},
				{ID: "cnt-bbb", Names: []string{"/openhive-beta"}, State: "exited"},
			}, nil
		},
	}

	rt := newTestRuntime(t, mock)
	list, err := rt.ListContainers(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 2)
	assert.Equal(t, "openhive-alpha", list[0].Name)
	assert.Equal(t, domain.ContainerStateRunning, list[0].State)
	assert.Equal(t, domain.ContainerStateStopped, list[1].State)
}

func TestEnsureNetwork_CreatesWithICCDisabled(t *testing.T) {
	var capturedOpts network.CreateOptions
	var capturedName string

	mock := &mockDockerClient{
		netListFn: func(_ context.Context, _ network.ListOptions) ([]network.Summary, error) {
			return nil, nil // network does not exist
		},
		netCreateFn: func(_ context.Context, name string, opts network.CreateOptions) (network.CreateResponse, error) {
			capturedName = name
			capturedOpts = opts
			return network.CreateResponse{ID: "net-abc123"}, nil
		},
	}

	rt := newTestRuntime(t, mock)
	netID, err := rt.EnsureNetwork(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "net-abc123", netID)
	assert.Equal(t, openhiveNetworkName, capturedName)
	assert.Equal(t, "false", capturedOpts.Options[networkICCOption])
}

func TestEnsureNetwork_ReusesExistingNetwork(t *testing.T) {
	createCalled := false
	mock := &mockDockerClient{
		netListFn: func(_ context.Context, _ network.ListOptions) ([]network.Summary, error) {
			return []network.Summary{
				{ID: "existing-net-id", Name: openhiveNetworkName},
			}, nil
		},
		netCreateFn: func(_ context.Context, _ string, _ network.CreateOptions) (network.CreateResponse, error) {
			createCalled = true
			return network.CreateResponse{}, nil
		},
	}

	rt := newTestRuntime(t, mock)
	netID, err := rt.EnsureNetwork(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "existing-net-id", netID)
	assert.False(t, createCalled, "NetworkCreate should not be called when network already exists")
}

func TestCreateContainer_DockerError(t *testing.T) {
	mock := &mockDockerClient{
		createFn: func(_ context.Context, _ *container.Config, _ *container.HostConfig, _ *network.NetworkingConfig, _ string) (container.CreateResponse, error) {
			return container.CreateResponse{}, errors.New("docker: out of space")
		},
	}

	rt := newTestRuntime(t, mock)
	_, err := rt.CreateContainer(context.Background(), domain.ContainerConfig{Name: "team-fail"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "docker: out of space")
}

func TestSanitizeEnvVars_ValidKeys(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	env := map[string]string{
		"WS_URL":           "ws://localhost:8080",
		"ANTHROPIC_API_KEY": "sk-test",
		"_PRIVATE":         "val",
	}
	result, err := sanitizeEnvVars(env, logger)
	require.NoError(t, err)
	assert.Len(t, result, 3)
}

func TestSanitizeEnvVars_RejectsInvalidKeyName(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	tests := []struct {
		name string
		env  map[string]string
	}{
		{"leading digit", map[string]string{"1BADKEY": "value"}},
		{"hyphen in key", map[string]string{"BAD-KEY": "value"}},
		{"space in key", map[string]string{"BAD KEY": "value"}},
		{"equals in key", map[string]string{"BAD=KEY": "value"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := sanitizeEnvVars(tt.env, logger)
			require.Error(t, err)
			var ve *domain.ValidationError
			assert.ErrorAs(t, err, &ve)
		})
	}
}

func TestSanitizeEnvVars_SkipsValuesWithNewlines(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	env := map[string]string{
		"GOOD_KEY":  "clean-value",
		"EVIL_KEY":  "line1\nline2",
		"NULL_KEY":  "val\x00null",
		"CRLF_KEY":  "line1\r\nline2",
	}
	result, err := sanitizeEnvVars(env, logger)
	require.NoError(t, err)
	// Only GOOD_KEY should survive
	assert.Len(t, result, 1)
	assert.Contains(t, result, "GOOD_KEY=clean-value")
}

func TestCreateContainer_RejectsInvalidEnvKey(t *testing.T) {
	mock := &mockDockerClient{}
	rt := newTestRuntime(t, mock)

	_, err := rt.CreateContainer(context.Background(), domain.ContainerConfig{
		Name: "team-bad-env",
		Env: map[string]string{
			"123INVALID": "value",
		},
	})
	require.Error(t, err)
	var ve *domain.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestParseMemoryLimit(t *testing.T) {
	tests := []struct {
		input   string
		want    int64
		wantErr bool
	}{
		{"512m", 512 * 1024 * 1024, false},
		{"1g", 1024 * 1024 * 1024, false},
		{"256M", 256 * 1024 * 1024, false},
		{"1G", 1024 * 1024 * 1024, false},
		{"100k", 100 * 1024, false},
		{"", 0, true},
		{"notanumber", 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, err := parseMemoryLimit(tt.input)
			if tt.wantErr {
				assert.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.want, got)
			}
		})
	}
}

func TestMapDockerStateString(t *testing.T) {
	tests := []struct {
		input string
		want  domain.ContainerState
	}{
		{"created", domain.ContainerStateCreated},
		{"running", domain.ContainerStateRunning},
		{"restarting", domain.ContainerStateStarting},
		{"paused", domain.ContainerStateStopped},
		{"exited", domain.ContainerStateStopped},
		{"dead", domain.ContainerStateStopped},
		{"removing", domain.ContainerStateStopping},
		{"unknown", domain.ContainerStateError},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			assert.Equal(t, tt.want, mapDockerStateString(tt.input))
		})
	}
}
