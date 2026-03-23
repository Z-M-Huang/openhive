# Skill: Deploy

## Purpose
Deploy a service to production following the standard procedure.

## Steps
1. Verify all tests pass on the target branch
2. Pull latest code: `git checkout main && git pull`
3. Run the test suite: `npm test`
4. Build the production artifact: `npm run build`
5. Run the deploy script: `./scripts/deploy.sh production`
6. Verify the health endpoint returns 200
7. Monitor error rates for 5 minutes

## Inputs
- Branch name (default: main)
- Service name

## Outputs
- Deploy status (success/failure)
- Health check result
- Error rate summary

## Error Handling
- If tests fail: STOP, report failure, do not deploy
- If build fails: STOP, report the build error
- If health check fails after deploy: run `./scripts/deploy.sh rollback`
