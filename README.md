 
# Development

Install dependencies:

```bash
npm install
```

Start both frontend and backend servers (monorepo mode):

```bash
npm run dev
```

## Frontend Only

To start only the frontend development server:

```bash
npm run dev -w frontend
```

Open the frontend at http://localhost:5173.

## Backend Only

To start only the backend development server:

```bash
npm run dev -w backend
```

The backend will run on http://localhost:3000.

## Building Frontend

Build the frontend for production:

```bash
npm run build -w frontend
```

Preview the production build:

```bash
npm run serve -w frontend
```

## Starting Backend in Production

Start the backend without auto-reloading:

```bash
npm run start -w backend
```

# Licensing

This program is licensed under the AGPL-3.0.
See [COPYING](./COPYING) file for details.
