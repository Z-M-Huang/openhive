.PHONY: build build-go build-agent-runner build-web \
       test test-go test-agent-runner test-web \
       lint lint-go lint-agent-runner lint-web \
       coverage coverage-go coverage-agent-runner coverage-web \
       generate check dev docker-build clean

# Build order: generate -> build-agent-runner -> build-web -> build-go
# web/dist/ MUST exist before build-go (go:embed)
build: generate build-agent-runner build-web build-go

build-go: build-web
	@echo "==> Building Go binary..."
	@mkdir -p bin
	@rm -rf cmd/openhive/web_dist
	@cp -r web/dist cmd/openhive/web_dist
	CGO_ENABLED=1 go build -o bin/openhive ./cmd/openhive

build-agent-runner: generate
	@echo "==> Building agent-runner..."
	cd agent-runner && bun install --frozen-lockfile 2>/dev/null || cd agent-runner && bun install
	cd agent-runner && bun run build

build-web: build-agent-runner
	@echo "==> Building web..."
	cd web && bun install --frozen-lockfile 2>/dev/null || cd web && bun install
	cd web && bun run build

# Pre-commit gate: generate, lint, test
check: generate lint test

test: test-go test-agent-runner test-web

test-go:
	@echo "==> Running Go tests..."
	CGO_ENABLED=1 go test ./... -count=1 -race

test-agent-runner:
	@echo "==> Running agent-runner tests..."
	cd agent-runner && bun install --frozen-lockfile 2>/dev/null || cd agent-runner && bun install
	cd agent-runner && bun run test

test-web:
	@echo "==> Running web tests..."
	cd web && bun install --frozen-lockfile 2>/dev/null || cd web && bun install
	cd web && bun run test

lint: lint-go lint-agent-runner lint-web

lint-go:
	@echo "==> Linting Go..."
	~/go/bin/golangci-lint run ./...

lint-agent-runner:
	@echo "==> Linting agent-runner..."
	cd agent-runner && bun install --frozen-lockfile 2>/dev/null || cd agent-runner && bun install
	cd agent-runner && bun run lint || true

lint-web:
	@echo "==> Linting web..."
	cd web && bun install --frozen-lockfile 2>/dev/null || cd web && bun install
	cd web && bun run lint || true

coverage: coverage-go coverage-agent-runner coverage-web

coverage-go:
	@echo "==> Go coverage..."
	@mkdir -p coverage
	CGO_ENABLED=1 go test ./... -coverprofile=coverage/go.out -count=1
	go tool cover -func=coverage/go.out

coverage-agent-runner:
	@echo "==> Agent-runner coverage..."
	@mkdir -p coverage
	cd agent-runner && bun install --frozen-lockfile 2>/dev/null || cd agent-runner && bun install
	cd agent-runner && bun run test:coverage || true

coverage-web:
	@echo "==> Web coverage..."
	@mkdir -p coverage
	cd web && bun install --frozen-lockfile 2>/dev/null || cd web && bun install
	cd web && bun run test:coverage || true

generate:
	@echo "==> Generating mocks..."
	~/go/bin/mockery 2>/dev/null || true

dev:
	@echo "==> Starting development mode..."
	go run ./cmd/openhive

docker-build:
	@echo "==> Building Docker images..."
	docker build -t openhive-team -f deployments/Dockerfile.team .
	docker build -t openhive -f deployments/Dockerfile .

clean:
	@echo "==> Cleaning..."
	rm -rf bin/ coverage/
	rm -rf agent-runner/dist/ agent-runner/node_modules/
	rm -rf web/dist/ web/node_modules/
