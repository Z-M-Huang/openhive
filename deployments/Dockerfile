# OpenHive Master Container Image
# Extends team base with Go backend binary

FROM openhive-team AS base

# Copy Go binary (statically compiled)
COPY bin/openhive /usr/local/bin/openhive

# Go binary is PID 1, spawns Node.js orchestrator as child process
ENTRYPOINT ["/usr/local/bin/openhive"]
