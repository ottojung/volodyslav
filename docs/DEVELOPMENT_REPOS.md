# Development Repository Setup

This project supports two test event log repositories for development:

## Available Repositories

### 1. Empty Repository (for testing clean slate scenarios)
- **Location**: `backend/tests/mock-event-log-repository`
- **Contents**: Empty Git repository with no events or configuration
- **Use case**: Testing the application behavior when starting fresh

### 2. Populated Repository (default for development)
- **Location**: `backend/tests/mock-event-log-repository-populated`
- **Contents**: Sample events and configuration with shortcuts
- **Use case**: Development with realistic data for better UX testing

## Switching Between Repositories

### Using the Populated Repository (Default)
```bash
# Simply run the development server - it uses the populated repository by default
./scripts/run-development-server
```

### Using the Empty Repository
```bash
# Set the environment variable to use the empty repository
VOLODYSLAV_USE_EMPTY_REPO=1 ./scripts/run-development-server
```

## Repository Contents

### Populated Repository Includes:
- **Sample Events**: 8 different event types (food, sleep, exercise, work, leisure, mood)
- **Configuration**: Help text and 15 useful shortcuts including:
  - Meal shortcuts: `breakfast`, `lunch`, `dinner`
  - Beverage shortcuts: `coffee`, `tea`
  - Activity shortcuts: `gym`, `run`, `walk`, `meeting`, `coding`, `reading`
  - Duration shortcuts: `slept 8h` → `sleep [duration 8 hours]`
  - Mood shortcuts: `tired`, `happy`

### Configuration API
The frontend now loads configuration from the backend API instead of using hardcoded demo data. When no configuration is available, the config section is hidden.

## Development Workflow

1. **Default Development**: Use populated repository for realistic development experience
2. **Clean Slate Testing**: Use empty repository to test initial user experience
3. **Configuration Testing**: Modify `backend/tests/mock-event-log-repository-populated` to test different configurations
