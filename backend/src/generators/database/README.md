# Generators Database Module

Generators work inside an SQL database to process event log entries and generate additional data for storage.

## Overview

This module provides a thin SQLite interface for the generators subsystem using better-sqlite3. It manages:
- Generated values storage
- Event log mirror tables (events and modifiers)
- Database initialization and schema management

## Architecture

The module follows the same encapsulation pattern as `runtime_state_storage`:
- Factory function (`get()`) instead of direct constructor access
- Type guards for safe type checking
- Custom error classes for specific failure modes
- Async wrapper around synchronous better-sqlite3 API

## Usage

```javascript
const { get } = require('./generators/database');

// Get database instance (creates if not exists)
const db = await get(capabilities);

// Insert an event
await db.run(
    'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['event-id', 'event-type', '{}', '{}', 'Event description', '2024-01-01', '{}', 'creator']
);

// Query events
const events = await db.all('SELECT * FROM events WHERE type = ?', ['event-type']);
const event = await db.get('SELECT * FROM events WHERE id = ?', ['event-id']);

// Use transactions
await db.transaction(async () => {
    await db.run('INSERT INTO events ...');
    await db.run('INSERT INTO modifiers ...');
});

// Close when done
await db.close();
```

## Schema

### Events Table
Mirrors the event log entries:
- `id` TEXT PRIMARY KEY - Unique event identifier
- `type` TEXT - Event type
- `input` TEXT - Event input data (JSON)
- `original` TEXT - Original event data (JSON)
- `description` TEXT - Event description
- `date` TEXT - Event date
- `modifiers` TEXT - Event modifiers (JSON)
- `creator` TEXT - Event creator

### Modifiers Table
Stores extracted modifiers:
- `event_id` TEXT - Foreign key to events.id (CASCADE DELETE)
- `key` TEXT - Modifier key
- `value` TEXT - Modifier value
- PRIMARY KEY: (event_id, key)

## Technology

This module uses [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - the fastest and simplest SQLite library for Node.js. It provides:
- Synchronous API (wrapped with async interface for consistency)
- Best performance of all Node.js SQLite libraries
- Native compilation with no dependencies
- Full SQLite compatibility
- Simple prepared statement API

## Error Handling

All errors extend `DatabaseError` with specific subclasses:
- `DatabaseInitializationError` - Database/directory creation failures
- `TableCreationError` - Table schema creation failures  
- `DatabaseQueryError` - SQL query execution failures

Each error includes:
- `databasePath` - Path to the database file
- `cause` - Original error that caused the failure
- Additional context (e.g., `query`, `tableName`)

## Testing

See [`/workspace/backend/tests/database.test.js`](/workspace/backend/tests/database.test.js) for comprehensive test examples.

## File Structure

- [`class.js`](/workspace/backend/src/generators/database/class.js) - Database class with better-sqlite3 operations
- [`index.js`](/workspace/backend/src/generators/database/index.js) - Main entry point with `get()` function
- [`types.js`](/workspace/backend/src/generators/database/types.js) - JSDoc type definitions
- [`errors.js`](/workspace/backend/src/generators/database/errors.js) - Custom error classes
- [`tables.js`](/workspace/backend/src/generators/database/tables.js) - Schema definitions and table creation
