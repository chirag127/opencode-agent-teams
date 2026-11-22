export const schema = `
CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK (id = 1), project TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, leaderSessionID TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, teamID TEXT NOT NULL REFERENCES teams(id), name TEXT NOT NULL,
  sessionID TEXT NOT NULL, parentSessionID TEXT, role TEXT NOT NULL CHECK (role IN ('leader','worker')),
  state TEXT NOT NULL CHECK (state IN ('creating','ready','assigned','retired')),
  runtime TEXT NOT NULL DEFAULT 'unknown', runtimeAt INTEGER NOT NULL DEFAULT 0,
  agent TEXT, createdAt INTEGER NOT NULL, UNIQUE (teamID, name), UNIQUE (teamID, sessionID)
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_session ON members(sessionID) WHERE role = 'worker';
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, teamID TEXT NOT NULL REFERENCES teams(id), title TEXT NOT NULL, description TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','running','stopping','completed','failed','cancelled')),
  ownerSessionID TEXT, claimID TEXT, version INTEGER NOT NULL DEFAULT 1, progress TEXT, result TEXT, error TEXT,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, UNIQUE (teamID, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS active_owner ON tasks(ownerSessionID)
  WHERE ownerSessionID IS NOT NULL AND state IN ('claimed','running','stopping');
CREATE TABLE IF NOT EXISTS dependencies (
  teamID TEXT NOT NULL, taskID TEXT NOT NULL, dependencyID TEXT NOT NULL,
  PRIMARY KEY (taskID, dependencyID), CHECK (taskID <> dependencyID),
  FOREIGN KEY (teamID, taskID) REFERENCES tasks(teamID,id),
  FOREIGN KEY (teamID, dependencyID) REFERENCES tasks(teamID,id)
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, teamID TEXT NOT NULL REFERENCES teams(id), taskID TEXT NOT NULL REFERENCES tasks(id),
  actorSessionID TEXT NOT NULL, memberID TEXT NOT NULL REFERENCES members(id), claimID TEXT NOT NULL,
  requestID TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('dispatch','followup','release','cancel')),
  state TEXT NOT NULL CHECK (state IN ('pending','done')), messageID TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
  lastError TEXT, createdAt INTEGER NOT NULL, completedAt INTEGER,
  UNIQUE (teamID, actorSessionID, requestID)
);
CREATE TABLE IF NOT EXISTS receipts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, teamID TEXT NOT NULL REFERENCES teams(id), taskID TEXT REFERENCES tasks(id),
  actorSessionID TEXT NOT NULL, kind TEXT NOT NULL, claimID TEXT, detail TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS local_stops (
  teamID TEXT NOT NULL, actorSessionID TEXT NOT NULL, requestID TEXT NOT NULL, taskID TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('release','cancel')), claimID TEXT,
  PRIMARY KEY (teamID, actorSessionID, requestID),
  FOREIGN KEY (teamID, taskID) REFERENCES tasks(teamID,id)
);
CREATE TABLE IF NOT EXISTS request_aliases (
  teamID TEXT NOT NULL REFERENCES teams(id), actorSessionID TEXT NOT NULL, requestID TEXT NOT NULL,
  operationID TEXT NOT NULL REFERENCES operations(id), PRIMARY KEY (teamID, actorSessionID, requestID)
);
CREATE INDEX IF NOT EXISTS task_team ON tasks(teamID, createdAt);
CREATE INDEX IF NOT EXISTS receipt_team ON receipts(teamID, sequence);
`;
