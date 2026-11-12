# Social validation, 2026-11-12

Host integration and the isolated Minikube 1.35.1 Job passed the same real SQL,
Redis and RabbitMQ protocol scenarios. The Job completed successfully; its
status and protocol log are retained here. The local image ID was
`sha256:3e7a0e2278e6459103c2360ac4b59a4058d47ae7f42fd6b1c465ffd60a2a15e1`.

The unit log records 293 passes and three opt-in SQL skips. Separate real SQL
graph/profile and legacy suites each passed 13 tests with no skips. The source
manifest records runtime/protocol/test bytes at image build time.

Actual native game clients, full worldserver linking, production failover and
performance were not exercised by these checks.
