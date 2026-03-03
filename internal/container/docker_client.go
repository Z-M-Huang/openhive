package container

import (
	"context"
	"fmt"
	"log/slog"

	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	dockerclient "github.com/docker/docker/client"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

// sdkDockerClient adapts the Docker SDK *client.Client to our DockerClient interface.
// The SDK's ContainerCreate takes an extra *ocispec.Platform parameter that our
// interface omits (we always pass nil, which selects the default platform).
type sdkDockerClient struct {
	cli *dockerclient.Client
}

func (c *sdkDockerClient) ContainerCreate(
	ctx context.Context,
	cfg *container.Config,
	hostConfig *container.HostConfig,
	networkingConfig *network.NetworkingConfig,
	containerName string,
) (container.CreateResponse, error) {
	return c.cli.ContainerCreate(ctx, cfg, hostConfig, networkingConfig, nil, containerName)
}

func (c *sdkDockerClient) ContainerStart(ctx context.Context, containerID string, options container.StartOptions) error {
	return c.cli.ContainerStart(ctx, containerID, options)
}

func (c *sdkDockerClient) ContainerStop(ctx context.Context, containerID string, options container.StopOptions) error {
	return c.cli.ContainerStop(ctx, containerID, options)
}

func (c *sdkDockerClient) ContainerRemove(ctx context.Context, containerID string, options container.RemoveOptions) error {
	return c.cli.ContainerRemove(ctx, containerID, options)
}

func (c *sdkDockerClient) ContainerInspect(ctx context.Context, containerID string) (dockertypes.ContainerJSON, error) {
	return c.cli.ContainerInspect(ctx, containerID)
}

func (c *sdkDockerClient) ContainerList(ctx context.Context, options container.ListOptions) ([]dockertypes.Container, error) {
	return c.cli.ContainerList(ctx, options)
}

func (c *sdkDockerClient) NetworkCreate(ctx context.Context, name string, options network.CreateOptions) (network.CreateResponse, error) {
	return c.cli.NetworkCreate(ctx, name, options)
}

func (c *sdkDockerClient) NetworkInspect(ctx context.Context, networkID string, options network.InspectOptions) (network.Inspect, error) {
	return c.cli.NetworkInspect(ctx, networkID, options)
}

func (c *sdkDockerClient) NetworkList(ctx context.Context, options network.ListOptions) ([]network.Summary, error) {
	return c.cli.NetworkList(ctx, options)
}

// NewDockerRuntime creates a ContainerRuntime backed by the real Docker daemon.
// It reads connection settings from environment variables (DOCKER_HOST, etc.)
// and negotiates the API version automatically.
//
// Returns an error if the Docker daemon is unreachable. Callers should treat
// this as non-fatal for development environments without Docker.
func NewDockerRuntime(imageName string, logger *slog.Logger) (domain.ContainerRuntime, error) {
	cli, err := dockerclient.NewClientWithOpts(
		dockerclient.FromEnv,
		dockerclient.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, fmt.Errorf("connect to Docker daemon: %w", err)
	}

	return NewRuntime(&sdkDockerClient{cli: cli}, imageName, logger), nil
}
