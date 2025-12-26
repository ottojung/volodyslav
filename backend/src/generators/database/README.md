# Database Module

This module provides SQLite-based storage for the generators system. It maintains a mirror of the event log and stores generated values.

## Architecture

The database module follows the same patterns as `runtime_state_storage`:

- **Capabilities Pattern**: All side effects go through the capabilities object
- **Encapsulation**: The Database class is not exported directly, only factory functions
- **Nominal Typing**: Uses `__brand` field for type safety
- **Error Handling**: Custom error classes for database operations

## Usage

```javascript
const database = require('./generators/database');

async function example(capabilities) {
    // Get a database instance
    const db = await database.get(capabilities);
    
    // Insert into events table
    await db.run(
        "INSERT INTO events (id, type, input, original) VALUES (?, ?, ?, ?)",
        ["event-1", "diary-entry", "user input", "original data"]
    );
    
    // Query all events
    const events = await db.all("SELECT * FROM events");
    
    // Query single event
    const event = await db.get("SELECT * FROM events WHERE id = ?", ["event-1"]);
    
    // Close when done
    await db.close();
}
```

## Database Schema

### Events Table
- `id` (TEXT, PRIMARY KEY): Unique event identifier
- `type` (TEXT, NOT NULL): Event type
- `input` (TEXT, NOT NULL): User input
- `original` (TEXT, NOT NULL): Original event data

### Modifiers Table
- `id` (INTEGER, PRIMARY KEY AUTOINCREMENT): Auto-incrementing identifier

Additional columns can be added to the modifiers table as needed by generators.

## API

### `get(capabilities)`
Returns a database instance. The database file is stored in the working directory as `generators.db`.

**Parameters:**
- `capabilities`: Object containing `checker`, `creator`, `environment`, and `logger`

**Returns:** Promise<Database>

### Database Methods

#### `run(sql, params)`
Executes a SQL query that doesn't return rows (INSERT, UPDATE, DELETE, CREATE).

#### `all(sql, params)`
Executes a SQL query and returns all matching rows.

#### `get(sql, params)`
Executes a SQL query and returns the first matching row (or undefined).

#### `close()`
Closes the database connection.

## Error Handling

- `DatabaseError`: Base error class for database operations
- `DatabaseInitializationError`: Thrown when database initialization fails
- `DatabaseQueryError`: Thrown when a SQL query fails
