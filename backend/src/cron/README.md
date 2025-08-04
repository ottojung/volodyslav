# Custom Cron Implementation

A high-quality, feature-complete replacement for `node-cron` built specifically for this project.

## Features

- **Full 5-field cron expression support**: `minute hour day month weekday`
- **Immediate validation**: Invalid expressions are caught at schedule time
- **Nominal types**: Type-safe TaskId system prevents string mixing
- **DateTime integration**: Uses project's datetime module instead of native Date
- **Custom error classes**: Specific error types for better debugging
- **Modular architecture**: Split into logical, maintainable files
- **Comprehensive testing**: 51 test cases with timeout protection
- **node-cron compatibility**: Drop-in replacement with improved API

## Supported Cron Expressions

### Basic Examples
- `* * * * *` - Every minute
- `0 * * * *` - Every hour at minute 0
- `0 9 * * *` - Every day at 9:00 AM
- `0 9 * * 1` - Every Monday at 9:00 AM

### Advanced Features
- **Ranges**: `0 9-17 * * *` (9 AM to 5 PM)
- **Steps**: `*/15 * * * *` (every 15 minutes)
- **Lists**: `0,30 * * * *` (at minute 0 and 30)
- **Combinations**: `0 9-17/2 * * 1-5` (every 2 hours from 9-17 on weekdays)

## Architecture

### Core Modules
- **parser.js**: Main orchestration module
- **field_parser.js**: Individual field parsing logic
- **expression.js**: CronExpression data structure
- **calculator.js**: Date matching and next execution calculation
- **main_parser.js**: Expression parsing orchestration
- **scheduler.js**: Task scheduling and management
- **task_id.js**: Nominal TaskId type system
- **errors.js**: Custom error classes

### Key Design Principles
1. **Nominal typing**: Prevents runtime type errors
2. **Validate, don't verify**: Parse once, trust thereafter
3. **Custom errors**: Specific error classes for every failure mode
4. **DateTime abstraction**: Consistent with project patterns
5. **Modular design**: Each file under 300 lines

## Usage

### Basic Scheduling
```javascript
const cron = require('./src/cron');

// Create a scheduler
const scheduler = cron.make();

// Schedule a task
const taskId = scheduler.schedule('0 9 * * *', () => {
    console.log('Daily 9 AM task');
});

// Cancel a task
scheduler.cancel(taskId);

// Get all tasks
const tasks = scheduler.getTasks();
```

### Direct Parser Usage
```javascript
const { parseCronExpression, isValidExpression, nextExecution } = require('./src/cron');

// Validate expressions
console.log(isValidExpression('0 9 * * *')); // true
console.log(isValidExpression('invalid'));   // false

// Parse expressions
const expr = parseCronExpression('0 9 * * *');

// Calculate next execution
const next = nextExecution('0 9 * * *', new Date());
```

## Error Handling

The module provides specific error classes for different failure modes:

- **InvalidCronExpressionError**: Invalid cron expression format
- **FieldParseError**: Specific field parsing failures
- **CronCalculationError**: Date calculation errors
- **SchedulerError**: Task scheduling failures

## Testing

Run the cron tests with timeout protection:

```bash
# All cron tests
./test-with-timeout.sh tests/cron.*.test.js

# Specific test suites
npx jest tests/cron.parser.test.js
npx jest tests/cron.scheduler.test.js
npx jest tests/cron.index.test.js
```

## Migration from node-cron

This implementation is a drop-in replacement for node-cron with these improvements:

1. **Better error messages**: Specific error information for debugging
2. **Type safety**: Nominal types prevent common mistakes
3. **More robust**: Better error handling and edge case coverage
4. **Project integration**: Uses datetime module and follows project patterns
5. **Better testing**: Comprehensive test suite with timeout protection

### Breaking Changes
- Returns `TaskId` objects instead of strings (but compatible via toString())
- Uses DateTime objects internally (converted to Date in public API)
- Throws specific error types instead of generic Error

## Performance

- **Validation**: O(1) per field, validated once at schedule time
- **Execution calculation**: O(1) for most expressions
- **Memory**: Minimal overhead with efficient task storage
- **No external dependencies**: Pure JavaScript implementation
