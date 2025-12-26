# Generators Database Module

A LevelDB key-value store for the generators subsystem to manage generated values and event log mirrors.

## Overview

This module provides a thin LevelDB interface for the generators subsystem. It manages:
- Generated values storage
- Event log mirror as key-value pairs
- Database initialization and lifecycle management

## Architecture

The module follows the same encapsulation pattern as `runtime_state_storage`:
- Factory function (`get()`) instead of direct constructor access
- Type guards for safe type checking
- Custom error classes for specific failure modes
- Async wrapper around Level API

## Usage

```javascript
const { get } = require('./generators/database');

// Get database instance (creates if not exists)
const db = await get(capabilities);

// Store an event
await db.put('event:my-id', {
    id: 'my-id',
    type: 'event-type',
    description: 'Event description',
    date: '2024-01-01'
});

// Retrieve an event
const event = await db.get('event:my-id');

// Delete an event
await db.del('event:my-id');

// Get all keys with a prefix
const eventKeys = await db.keys('event:');

// Get all values with a prefix
const events = await db.getAll('event:');

// Batch operations (atomic)
await db.batch([
    { type: 'put', key: 'event:id1', value: { id: 'id1' } },
    { type: 'put', key: 'event:id2', value: { id: 'id2' } },
    { type: 'del', key: 'event:old-id' }
]);

// Close when done
await db.close();
```

## Key Naming Convention

Use colon-separated prefixes to organize keys:

- `event:{id}` - Event entries
- `modifier:{event_id}:{key}` - Event modifiers
- `generated:{type}:{id}` - Generated values

Examples:
```javascript
await db.put('event:2024-01-01-001', eventData);
await db.put('modifier:2024-01-01-001:location', { value: 'NYC' });
await db.put('generated:summary:2024-01', summaryData);
```

## Technology

This module uses [Level](https://github.com/Level/level) - a fast and simple key-value store for Node.js. It provides:
- Async/await API
- Efficient storage with LevelDB backend
- Range queries and iteration
- Atomic batch operations
- UTF-8 string values with JSON encoding

## Error Handling

All errors extend `DatabaseError` with specific subclasses:
- `DatabaseInitializationError` - Database/directory creation failures
- `DatabaseQueryError` - Key-value operation failures

Each error includes:
- `databasePath` - Path to the database directory
- `cause` - Original error that caused the failure
- `query` - Operation description (e.g., "PUT key", "GET key")

## Testing

See [database.test.js](../../../tests/database.test.js) for comprehensive test examples.

## File Structure

- [class.js](class.js) - Database class with Level operations
- [index.js](index.js) - Main entry point with `get()` function
- [types.js](types.js) - JSDoc type definitions
- [errors.js](errors.js) - Custom error classes

