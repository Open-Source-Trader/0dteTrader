# Privacy Policy

Version: 2026-08-05

0dteTrader processes the account email, a one-way password hash, access and refresh-token records, encrypted broker credentials, brokerage connection metadata, order and execution records, device push tokens, notification preferences, legal acceptances, and limited operational/security logs needed to provide the service. JWT access tokens are stored on the client for authenticated API requests; refresh tokens are stored in the operating system's protected credential storage where supported and only token hashes are retained by the server.

Broker and Discord webhook secrets are encrypted at rest. Credentials are used to make requests selected by the user and are not sold. Data may be sent to the user's configured broker, market-data provider, Apple Push Notification service, or Discord webhook solely to perform requested features. Push payloads may contain contract, side, quantity, status, and fill-price information; disabling push prevents new delivery rows from being created.

Optional AI features process only the prompt and market/account context shown for that request. Apple Intelligence integrations use the on-device or Apple-managed model path exposed by the operating system. A self-hosted operator that configures another model provider must identify it, disclose what is transmitted, and set an appropriate retention policy. 0dteTrader does not use trading or account data to train a project-owned model.

Self-hosted operators control their deployment, database, logs, retention, backups, subprocessors, and administrative access. Hosted operators must publish contact, jurisdiction, retention periods, and applicable privacy-rights instructions alongside this policy. The built-in push outbox removes terminal delivery attempts after seven days while pending/retry rows are retained until resolved. Other operational records remain until account deletion or the operator's published retention schedule.

Users can delete their account in Profile. Database cascade rules remove user-owned credential vault entries, sessions, orders and executions, webhook/event records, device tokens, notification settings, and acceptance records. Brokerages and independently configured providers retain their own records under their policies; deleting 0dteTrader cannot delete a broker's legally required account or trading history.

Security reports should follow the repository's SECURITY.md instructions. Privacy questions should be directed to the operator of the deployment being used.
