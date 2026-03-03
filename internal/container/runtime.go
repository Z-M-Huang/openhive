package container

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/Z-M-Huang/openhive/internal/domain"
)

const (
	// openhiveNetworkName is the Docker network all containers join.
	openhiveNetworkName = "openhive-network"

	// containerNamePrefix is prepended to every container name.
	containerNamePrefix = "openhive-"

	// networkICCOption disables inter-container communication on the bridge.
	networkICCOption = "com.docker.network.bridge.enable_icc"

	// defaultMemoryLimit for single-agent containers (512 MB).
	defaultMemoryLimit int64 = 512 * 1024 * 1024

	// defaultMemoryLimitMulti for multi-agent containers (1 GB).
	defaultMemoryLimitMulti int64 = 1024 * 1024 * 1024

	// containerUser is the non-root user that runs inside team containers.
	containerUser = "openhive"
)

// DockerClient wraps the Docker SDK methods used by RuntimeImpl, enabling
// injection of a mock in tests.
type DockerClient interface {
	ContainerCreate(
		ctx context.Context,
		config *container.Config,
		hostConfig *container.HostConfig,
		networkingConfig *network.NetworkingConfig,
		containerName string,
	) (container.CreateResponse, error)
	ContainerStart(ctx context.Context, containerID string, options container.StartOptions) error
	ContainerStop(ctx context.Context, containerID string, options container.StopOptions) error
	ContainerRemove(ctx context.Context, containerID string, options container.RemoveOptions) error
	ContainerInspect(ctx context.Context, containerID string) (dockertypes.ContainerJSON, error)
	ContainerList(ctx context.Context, options container.ListOptions) ([]dockertypes.Container, error)
	NetworkCreate(ctx context.Context, name string, options network.CreateOptions) (network.CreateResponse, error)
	NetworkInspect(ctx context.Context, networkID string, options network.InspectOptions) (network.Inspect, error)
	NetworkList(ctx context.Context, options network.ListOptions) ([]network.Summary, error)
}

// RuntimeImpl implements domain.ContainerRuntime using the Docker SDK.
type RuntimeImpl struct {
	client    DockerClient
	networkID string
	imageName string
	logger    *slog.Logger
}

// NewRuntime creates a new RuntimeImpl.
// imageName is the Docker image to use for team containers.
func NewRuntime(client DockerClient, imageName string, logger *slog.Logger) *RuntimeImpl {
	return &RuntimeImpl{
		client:    client,
		imageName: imageName,
		logger:    logger,
	}
}

// CreateContainer creates a new Docker container for a team.
// The ContainerConfig.Name field sets the team slug used for the container name.
// The ContainerConfig.Env map is merged into the container's environment.
// Returns the Docker container ID on success.
func (r *RuntimeImpl) CreateContainer(ctx context.Context, cfg domain.ContainerConfig) (string, error) {
	if cfg.Name == "" {
		return "", &domain.ValidationError{Field: "name", Message: "container name is required"}
	}

	containerName := containerNamePrefix + cfg.Name

	imageName := cfg.ImageName
	if imageName == "" {
		imageName = r.imageName
	}

	// Build environment variable list with sanitization.
	envList, err := sanitizeEnvVars(cfg.Env, r.logger)
	if err != nil {
		return "", fmt.Errorf("invalid container environment: %w", err)
	}

	// Memory limit: use config value if set, otherwise default.
	memLimit := defaultMemoryLimit
	if cfg.MaxMemory != "" {
		parsed, err := parseMemoryLimit(cfg.MaxMemory)
		if err != nil {
			r.logger.Warn("invalid max_memory in container config, using default",
				"value", cfg.MaxMemory,
				"error", err,
			)
		} else {
			memLimit = parsed
		}
	}

	containerCfg := &container.Config{
		Image: imageName,
		Env:   envList,
		User:  containerUser,
	}

	hostCfg := &container.HostConfig{
		NetworkMode: container.NetworkMode(r.networkID),
		Resources: container.Resources{
			Memory: memLimit,
		},
		RestartPolicy: container.RestartPolicy{
			Name: "on-failure",
		},
	}

	// Attach to the openhive-network by name.
	netCfg := &network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{
			openhiveNetworkName: {},
		},
	}

	resp, err := r.client.ContainerCreate(ctx, containerCfg, hostCfg, netCfg, containerName)
	if err != nil {
		return "", fmt.Errorf("create container %q: %w", containerName, err)
	}

	r.logger.Info("container created",
		"container_id", resp.ID,
		"container_name", containerName,
		"image", imageName,
	)
	return resp.ID, nil
}

// StartContainer starts a previously created container.
func (r *RuntimeImpl) StartContainer(ctx context.Context, containerID string) error {
	if err := r.client.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		return fmt.Errorf("start container %q: %w", containerID, err)
	}
	r.logger.Info("container started", "container_id", containerID)
	return nil
}

// StopContainer stops a running container, waiting up to timeout for graceful shutdown.
func (r *RuntimeImpl) StopContainer(ctx context.Context, containerID string, timeout time.Duration) error {
	secs := int(timeout.Seconds())
	opts := container.StopOptions{Timeout: &secs}
	if err := r.client.ContainerStop(ctx, containerID, opts); err != nil {
		return fmt.Errorf("stop container %q: %w", containerID, err)
	}
	r.logger.Info("container stopped", "container_id", containerID)
	return nil
}

// RemoveContainer removes a container (it must be stopped first unless force is implied by caller).
func (r *RuntimeImpl) RemoveContainer(ctx context.Context, containerID string) error {
	opts := container.RemoveOptions{Force: true}
	if err := r.client.ContainerRemove(ctx, containerID, opts); err != nil {
		return fmt.Errorf("remove container %q: %w", containerID, err)
	}
	r.logger.Info("container removed", "container_id", containerID)
	return nil
}

// InspectContainer returns the current state of a container.
func (r *RuntimeImpl) InspectContainer(ctx context.Context, containerID string) (*domain.ContainerInfo, error) {
	info, err := r.client.ContainerInspect(ctx, containerID)
	if err != nil {
		return nil, fmt.Errorf("inspect container %q: %w", containerID, err)
	}

	state := mapDockerState(info.State)
	name := strings.TrimPrefix(info.Name, "/")

	return &domain.ContainerInfo{
		ID:    info.ID,
		Name:  name,
		State: state,
	}, nil
}

// ListContainers returns all containers managed by OpenHive (name prefix filter).
func (r *RuntimeImpl) ListContainers(ctx context.Context) ([]domain.ContainerInfo, error) {
	f := filters.NewArgs()
	f.Add("name", containerNamePrefix)

	list, err := r.client.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: f,
	})
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}

	result := make([]domain.ContainerInfo, 0, len(list))
	for _, c := range list {
		state := mapDockerStateString(c.State)
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		result = append(result, domain.ContainerInfo{
			ID:    c.ID,
			Name:  name,
			State: state,
		})
	}
	return result, nil
}

// EnsureNetwork creates the openhive-network if it does not already exist.
// The network is configured with ICC (inter-container communication) disabled
// so containers cannot talk to each other directly.
// Returns the network ID.
func (r *RuntimeImpl) EnsureNetwork(ctx context.Context) (string, error) {
	// Check if the network already exists.
	list, err := r.client.NetworkList(ctx, network.ListOptions{
		Filters: filters.NewArgs(filters.Arg("name", openhiveNetworkName)),
	})
	if err != nil {
		return "", fmt.Errorf("list networks: %w", err)
	}

	for _, n := range list {
		if n.Name == openhiveNetworkName {
			r.networkID = n.ID
			r.logger.Debug("openhive-network already exists", "network_id", n.ID)
			return n.ID, nil
		}
	}

	// Create the network with ICC disabled.
	resp, err := r.client.NetworkCreate(ctx, openhiveNetworkName, network.CreateOptions{
		Driver: "bridge",
		Options: map[string]string{
			networkICCOption: "false",
		},
	})
	if err != nil {
		return "", fmt.Errorf("create network %q: %w", openhiveNetworkName, err)
	}

	r.networkID = resp.ID
	r.logger.Info("openhive-network created", "network_id", resp.ID)
	return resp.ID, nil
}

// mapDockerState converts a Docker container.State to domain.ContainerState.
func mapDockerState(state *dockertypes.ContainerState) domain.ContainerState {
	if state == nil {
		return domain.ContainerStateStopped
	}
	return mapDockerStateString(state.Status)
}

// mapDockerStateString converts a Docker status string to domain.ContainerState.
func mapDockerStateString(status string) domain.ContainerState {
	switch status {
	case "created":
		return domain.ContainerStateCreated
	case "running":
		return domain.ContainerStateRunning
	case "restarting":
		return domain.ContainerStateStarting
	case "paused", "exited", "dead":
		return domain.ContainerStateStopped
	case "removing":
		return domain.ContainerStateStopping
	default:
		return domain.ContainerStateError
	}
}

// envVarKeyPattern matches valid POSIX environment variable names:
// must start with a letter or underscore, followed by letters, digits, or underscores.
var envVarKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// sanitizeEnvVars validates and sanitizes a map of environment variables.
// Key names must match ^[A-Za-z_][A-Za-z0-9_]*$.
// Values must not contain newline characters (\n, \r) or null bytes (\x00).
// Returns a ValidationError if any key is invalid.
// Entries with invalid values are skipped with a warning log.
func sanitizeEnvVars(envMap map[string]string, logger *slog.Logger) ([]string, error) {
	result := make([]string, 0, len(envMap))
	for k, v := range envMap {
		if !envVarKeyPattern.MatchString(k) {
			return nil, &domain.ValidationError{
				Field:   "env",
				Message: fmt.Sprintf("environment variable name %q is invalid (must match ^[A-Za-z_][A-Za-z0-9_]*$)", k),
			}
		}
		if strings.ContainsAny(v, "\n\r\x00") {
			logger.Warn("environment variable value contains unsafe characters; skipping",
				"key", k,
			)
			continue
		}
		result = append(result, k+"="+v)
	}
	return result, nil
}

// parseMemoryLimit parses a human-readable memory limit like "512m", "1g" into bytes.
func parseMemoryLimit(s string) (int64, error) {
	if s == "" {
		return 0, fmt.Errorf("empty memory limit")
	}

	s = strings.ToLower(strings.TrimSpace(s))

	multiplier := int64(1)
	suffix := s[len(s)-1:]
	numStr := s

	switch suffix {
	case "k":
		multiplier = 1024
		numStr = s[:len(s)-1]
	case "m":
		multiplier = 1024 * 1024
		numStr = s[:len(s)-1]
	case "g":
		multiplier = 1024 * 1024 * 1024
		numStr = s[:len(s)-1]
	}

	var value int64
	if _, err := fmt.Sscanf(numStr, "%d", &value); err != nil {
		return 0, fmt.Errorf("parse memory limit %q: %w", s, err)
	}

	return value * multiplier, nil
}
