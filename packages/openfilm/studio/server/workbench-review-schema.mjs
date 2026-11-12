export const WORKBENCH_REVIEW_SCHEMA = `
  CREATE TABLE hooks (
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, kind, text)
  );
  CREATE TABLE video_variants (
    account_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    label TEXT NOT NULL CHECK (label IN ('A', 'B')),
    title TEXT,
    cover TEXT,
    impressions INTEGER CHECK (impressions >= 0),
    clicks INTEGER CHECK (clicks BETWEEN 0 AND impressions),
    PRIMARY KEY (account_id, video_id, label),
    FOREIGN KEY (account_id, video_id) REFERENCES videos(account_id, id)
  );
  CREATE TABLE video_reviews (
    account_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    captured_at INTEGER NOT NULL,
    findings TEXT NOT NULL,
    hypotheses TEXT NOT NULL,
    next_test TEXT NOT NULL,
    PRIMARY KEY (account_id, video_id),
    FOREIGN KEY (account_id, video_id) REFERENCES videos(account_id, id)
  );
`;
