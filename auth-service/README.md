# Authorization Server - AuthTool

An OAuth 2.0 Authorization Server built with Node.js and Express that implements secure authorization flows including Proof Key for Code Exchange (PKCE) and JSON Web Tokens (JWT).

## Features

- **User Authentication**: Secure user registration and login using `bcrypt` password hashing.
- **OAuth 2.0 Authorization Code Flow**: Full implementation of the `authorization_code` grant type.
- **PKCE Support**: Enhanced security for public clients via Proof Key for Code Exchange (S256 and plain methods).
- **JWT Access Tokens**: Stateless, signed JSON Web Tokens for secure resource access.
- **State Validation**: Protection against Cross-Site Request Forgery (CSRF) via the `state` parameter.
- **Consent Screen**: Interactive user consent interface for approving application permissions.

## Prerequisites

- Node.js (v16 or higher recommended)
- MongoDB running locally or a MongoDB connection string.

## Installation

1. Navigate to the `authorization-server` directory:
   ```bash
   cd authorization-server
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the example environment file and configure your variables:
   ```bash
   cp .env.example .env
   ```

## Environment Variables

| Variable | Description | Example |
| -------- | ----------- | ------- |
| `MONGODB_URI` | Connection string for your MongoDB database | `mongodb://localhost:27017/oauth_auth_server` |
| `PORT` | The port the server will run on | `3000` |
| `SESSION_SECRET` | Secret key for encrypting HTTP sessions (Min 32 chars) | `your_long_session_secret_key_123` |
| `JWT_SECRET` | Secret key used to sign Access Tokens (Min 32 chars) | `your_long_jwt_signature_secret_key` |

## Seeding the Database

Before a client application can request authorization, it must be registered in the Authorization Server's database. Run the following command to automatically seed the `test_client_app`:

```bash
npm run seed-client
```

## Running the Server

Start the server in development mode (auto-restarts on changes):
```bash
npm run dev
```

Start the server for production:
```bash
npm start
```

## API Endpoints

### Authentication
- `GET /register`: Displays the user registration form.
- `POST /register`: Creates a new user account.
  - Parameters: `username`, `password`
- `GET /login`: Displays the user login form.
- `POST /login`: Authenticates a user and starts a session.
  - Parameters: `username`, `password`
- `POST /logout`: Terminates the current user session.

### OAuth 2.0
- `GET /authorize`: Initiates the OAuth flow and displays the consent screen.
  - Query Params: `response_type=code`, `client_id`, `redirect_uri`, `state`, `scope`, `code_challenge`, `code_challenge_method`
- `POST /authorize/approve`: Approves the client request, generates an authorization code, and redirects.
- `POST /authorize/deny`: Denies the client request and redirects with an error.
- `POST /token`: Exchanges an authorization code for a JWT access token.
  - Body Params: `grant_type=authorization_code`, `code`, `client_id`, `redirect_uri`, `code_verifier`

## Security Overview

This server enforces several explicit security mechanisms:
1. **PKCE Validation**: Ensures the entity exchanging the authorization code is the precise entity that requested it.
2. **Short-Lived Codes**: Authorization codes expire after 10 minutes to reduce interception windows.
3. **Single-Use Codes**: Any attempt to reuse an authorization code throws an `invalid_grant` exception immediately.
4. **Bcrypt Hashing**: All passwords are automatically salted and hashed (`$2b$`) before touching the database.

## Database Schema

The server connects to MongoDB and utilizes 3 main collections, applying automatic unique indexes on key fields:
- **`users`**: `{ username, password (hashed) }`
- **`clients`**: `{ client_id, client_secret, name, redirect_uris }`
- **`auth_codes`**: `{ code, client_id, user_id, redirect_uri, expires_at, used (boolean), code_challenge, code_challenge_method }`

## Troubleshooting

- **Server won't start?** Verify MongoDB is running locally (`mongod`), and that `MONGODB_URI` points to the correct location.
- **Client getting "invalid_client"?** Ensure you have run `npm run seed-client` first.
- **Client getting "PKCE validation failed"?** Ensure the target application is sending a valid `code_verifier` string that evaluates accurately against the `code_challenge`.

---
**Author**: Toluwalase Mebaanne
