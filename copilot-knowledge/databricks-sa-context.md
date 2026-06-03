# Databricks SA Co-pilot Knowledge Base

## Unity Catalog

Unity Catalog (UC) introduces a three-level namespace — `catalog.schema.table` — that unifies governance across all Databricks workspaces in an account. Unlike Hive Metastore (one metastore per workspace, limited cross-workspace sharing), Unity Catalog is account-level: a single metastore governs all workspaces, enabling consistent access control, audit logging, and data lineage without duplicating grants across environments.

**Key capabilities:**
- Fine-grained RBAC: column-level masking policies, row-level filters (using row filter functions), and attribute-based access control with dynamic views
- Data lineage: system table `system.access.column_lineage` and `system.access.table_lineage` track read/write provenance at column level — available out of the box, no agents needed
- Audit logging: every query, create, delete, and grant is recorded in `system.access.audit`; exportable to SIEM
- External locations and storage credentials: securely register S3/ADLS/GCS paths without embedding credentials in notebooks
- Delta Sharing integration: publish live Delta tables to external recipients (no data movement)

**Differentiators vs competitors:**
- **vs Hive Metastore**: UC controls access at query-execution time, not just metadata registration. Hive Metastore cannot enforce column masking or row filters dynamically.
- **vs Snowflake**: UC governs open-format Delta Lake tables. Snowflake governance is closed-format and proprietary; data must live in Snowflake storage. UC allows existing data lakes to be governed without migration.
- **vs Microsoft Purview**: Purview is a metadata overlay — it labels and classifies but cannot enforce access at query time. UC enforces policy at the compute layer (Spark, SQL Warehouse, ML Runtime), making it operationally effective rather than advisory.

**Common objection:** "We already have a data catalog (Collibra, Alation)."
Response: UC is not a business glossary — it's a compute-integrated governance engine. You can continue using Collibra for business metadata while UC enforces technical access policy at query time. They are complementary.

---

## Genie (AI/BI)

Genie is Databricks' natural-language-to-SQL interface built into AI/BI dashboards. Users type questions in plain English; Genie generates SQL, runs it against registered datasets, and returns answers grounded in actual data.

**How it works:**
- SA or data engineer creates a "Genie Room" scoped to specific Unity Catalog tables
- Genie Rooms include verified queries (examples the model can reference) and a business context description
- When a user asks a question outside the verified scope, Genie explicitly says it cannot answer rather than hallucinating — this is the key differentiator from generic LLM chatbots
- Answers are pinned to Delta Lake data (no stale caches); time-travel queries are supported

**Differentiators vs competitors:**
- **vs Power BI Q&A**: Power BI Q&A uses a semantic model but doesn't use LLM reasoning for complex multi-step questions. Genie generates full SQL with joins and aggregations. Power BI Q&A struggles with questions that require combining multiple tables dynamically.
- **vs Tableau Ask Data** (now "Tableau Pulse"): Tableau Pulse focuses on pre-configured KPI metrics. Genie supports ad-hoc SQL generation against any registered table. Genie is also enterprise-authenticated via Unity Catalog — the same column masking and row filters that govern normal SQL queries apply to Genie answers.
- **vs generic ChatGPT/Copilot integrations**: Those tools send data to external LLMs and can hallucinate SQL or fabricate numbers. Genie runs on Databricks infrastructure, governed by UC, and is required to execute SQL and return real data — not fabricated answers.

**Common objection:** "LLMs hallucinate — how do I trust the numbers?"
Response: Genie is different from a generic LLM. It is constrained to execute SQL against live Delta tables and return actual results. If it cannot generate a confident SQL query for a question, it responds "I don't know" rather than guessing. You can review the generated SQL before trusting the answer. Verified queries (curated examples you add) further anchor Genie's behavior for your most critical questions.

---

## Delta Sharing

Delta Sharing is an open protocol (Linux Foundation) for sharing live Delta Lake data across organizations, clouds, and tools — without copying the data.

**How it works:**
- Data provider registers a Delta table as a "share" and creates a recipient (a token or identity)
- Recipient accesses the share via REST API using their preferred client: Spark, Pandas, Power BI, Tableau, or any JDBC/ODBC tool — no Databricks required on the recipient side
- Data remains in the provider's cloud storage (S3, ADLS, GCS); recipient accesses pre-signed URLs for the Parquet files in the share
- Streaming shares (Delta streaming) and ML model sharing are also supported

**Differentiators vs competitors:**
- **vs Snowflake Secure Data Sharing**: Snowflake sharing is Snowflake-to-Snowflake only; the recipient must have a Snowflake account. Delta Sharing is cloud-agnostic and tool-agnostic — a pharma company can share clinical data with a CRO using Pandas or Power BI without either party being locked into a single vendor.
- **vs Azure Data Share / AWS Data Exchange**: Those services involve physical data replication. Delta Sharing gives recipients access to live data (the actual Delta files) with no copy; updates are visible immediately without re-sharing.

**Use case (pharma):** Share clinical trial datasets with a CRO for analysis without data egress. The CRO accesses the share with their preferred tool; the data never leaves the sponsor's cloud account; UC audit logs record every access.

---

## Lakebase

Lakebase is Databricks' serverless Postgres offering backed by object storage (S3, ADLS, or GCS). It is a fully managed transactional database — no server to provision, no DBA overhead — with automatic scaling to zero when idle.

**Key capabilities:**
- Standard Postgres wire protocol — any Postgres-compatible client, ORM, or BI tool works
- ACID transactions, foreign keys, indexes
- Time-travel via Delta Lake versioning: query historical states of the database
- Native Unity Catalog integration: tables appear in UC namespace, inheriting all governance policies
- Designed for operational workloads that need to coexist with analytics: feature stores, operational dashboards, application backends, real-time serving tables

**Differentiators vs competitors:**
- **vs Amazon Aurora**: Aurora is server-based (even Aurora Serverless v2 has a minimum capacity floor). Lakebase scales to true zero cost when idle. Lakebase data is in open Delta format — readable directly by Spark/SQL Warehouses without ETL.
- **vs AlloyDB / Supabase**: Those are standalone Postgres services without lakehouse integration. Lakebase shares governance, lineage, and storage with the rest of the Databricks lakehouse — one platform, one catalog, one governance model.
- **vs Azure SQL / RDS**: These require schema migration to move data to the analytics layer. With Lakebase, the same Delta tables powering ML pipelines or streaming jobs are also queryable with SQL from application code.

**Common objection:** "We already have PostgreSQL / Aurora for our app database."
Response: Lakebase is not trying to replace your OLTP database for every workload. The value is for workloads where you need both transactional writes and analytical reads from the same table — feature stores, real-time serving, operational BI — and where you want to eliminate the ETL pipeline between your app DB and data warehouse.

---

## AgentBricks / Mosaic AI Agent Framework

Mosaic AI Agent Framework is Databricks' production-grade platform for building, evaluating, and deploying multi-agent AI systems.

**Key components:**
- **Agent authoring**: supports LangChain, LangGraph, and pure Python tool-calling patterns; agents can call Unity Catalog functions as tools (SQL queries, Python UDFs, external APIs)
- **MLflow LLM Tracing**: every agent run is traced — inputs, outputs, retrieved context, tool calls, latency, token usage — stored in MLflow experiments for debugging and regression testing
- **Agent Evaluation harness**: automated quality testing using LLM-as-a-judge and custom metrics; run evals on a golden dataset before deploying to production
- **Model Serving**: deploy agents as REST endpoints with autoscaling, GPU support, and A/B traffic splitting
- **Lakehouse integration**: agents can query Delta tables, read from Unity Catalog volumes, write results back to Delta — all governed by UC row/column policies

**Differentiators vs competitors:**
- **vs pure LangChain/LangGraph**: LangChain and LangGraph are excellent dev-time frameworks but provide no production observability. Mosaic AI adds MLflow tracing (who called what, when, with what data), Agent Evaluation (did the answer quality regress after a prompt change?), and governed Model Serving — the parts that matter for enterprise production deployments.
- **vs Azure OpenAI / Copilot Studio**: These are cloud-specific and closed. Mosaic AI is model-agnostic (works with Llama, Mistral, Claude, GPT-4, DBRX) and open-source at the framework layer (MLflow, LangChain). You are not locked into a single foundation model vendor.
- **vs AWS Bedrock Agents**: Bedrock Agents are tightly coupled to AWS services. Mosaic AI agents can federate across tools, databases, and APIs regardless of cloud.

**Common objection:** "We'll just build this on open-source LangChain ourselves."
Response: The hard part of agentic AI is not writing the agent logic — it's evaluating whether the agent is correct, debugging when it fails in production, and updating the agent without breaking existing behavior. Mosaic AI provides the evaluation harness, tracing, and governed deployment layer that LangChain alone does not include. You write the same LangChain code; Databricks adds the enterprise wrapper.

---

## MLflow

MLflow is the open-source ML lifecycle platform originally created at Databricks and now a Linux Foundation project with hundreds of enterprise contributors. It is the de facto standard for ML experiment tracking.

**Core capabilities (MLflow 2.x+):**
- Experiment tracking: log parameters, metrics, artifacts, and model versions with full reproducibility
- Model Registry: versioned, signed model artifacts with stage transitions (Staging → Production) and approval workflows
- Model Serving: REST endpoint deployment with A/B testing and traffic splitting
- LLM Tracing (MLflow 2.14+): structured traces for LLM calls — prompt, response, retrieved context, tool calls, latency, token count — stored alongside standard ML experiments
- Evaluate: run automated evaluations of LLM responses using judges (GPT-4, Claude) against ground truth datasets

**Differentiators vs competitors:**
- **vs Weights & Biases (W&B)**: W&B is a SaaS product requiring data to leave your environment. MLflow is open-source and self-hosted — critical for regulated industries (pharma, finance, healthcare) where model artifacts and training data cannot leave the corporate environment. Databricks fully manages MLflow in the platform with enterprise support SLAs.
- **vs Comet ML**: Comet is also SaaS-only. MLflow provides the same experiment tracking capabilities with full on-premises or VPC-isolated deployment.

**GxP / Pharma angle (21 CFR Part 11, GAMP 5):**
- FDA regulations for AI/ML-based clinical decision tools require documented model validation — the system must prove the model was trained on specific data, with specific hyperparameters, producing a specific artifact
- MLflow's model registry provides a version-controlled, signed artifact with full experiment lineage. This is the core of a Computer Software Assurance (CSA) package for FDA submissions
- Delta Lake time-travel provides reproducible historical states: you can re-query the exact training dataset snapshot used for model version 1.3 three years later — essential for audit trails during regulatory inspection
- Model Registry approval workflows (Staging → Production with named approver) satisfy electronic signature requirements under 21 CFR Part 11

---

## Common Enterprise Objections

| Objection | Response |
|---|---|
| "We're already on Snowflake" | Databricks and Snowflake frequently coexist. Ask where ML training, streaming pipelines, and unstructured data processing happen — those workloads almost always go to Databricks. The conversation is about where each platform excels, not replacement. |
| "Spark is too complex for our analysts" | Serverless SQL and Genie abstract Spark entirely for analysts. They use SQL or plain English. Only pipeline and ML engineers touch Spark directly, and they benefit from the performance. |
| "Too expensive — we can just use S3 + Athena" | Athena is query-only — no ACID writes, no streaming ingestion, no governance, no ML. TCO comparison needs to include: DBA overhead for managing separate systems, storage duplication (data warehouse + data lake), separate ML infrastructure (SageMaker), and separate governance tooling (Purview/Collibra). Databricks consolidates all of this. |
| "We don't want open-source risk" | Delta Lake and MLflow are Linux Foundation projects with formal governance and Databricks enterprise support SLAs. The risk profile is equivalent to Apache Kafka or PostgreSQL — widely adopted, commercially supported, with no single-vendor lock-in. |
| "We'll use Microsoft Fabric" | Fabric's lakehouse (OneLake) is early-stage. Unity Catalog has been production-hardened across thousands of enterprises since 2021. Fabric has no native streaming engine comparable to Spark Structured Streaming. Fabric's AI/ML capabilities (AutoML) are not comparable to Mosaic AI's agent framework and evaluation harness. Many Fabric+Databricks deployments coexist — Databricks for heavy compute and ML, Fabric for Power BI semantic layer and Office 365 integration. |
| "Azure OpenAI / Copilot already covers our AI needs" | Azure OpenAI provides LLM API access; it is not a data platform or an ML platform. It does not provide: feature engineering pipelines, model training infrastructure, experiment tracking, evaluation frameworks, or data governance. Databricks provides the full ML platform that Azure OpenAI sits on top of. |

---

## Pharma / GxP Positioning

Databricks is uniquely positioned for pharmaceutical and life sciences customers with regulatory requirements:

**21 CFR Part 11 (Electronic Records and Signatures):**
- Delta Lake's immutable transaction log ensures electronic records cannot be altered without a traceable audit trail
- Unity Catalog audit logs record every data access and modification with timestamp and user identity
- MLflow Model Registry provides electronic approval workflows with named approvers — satisfying signature requirements

**GAMP 5 (Validated Computing):**
- Delta Lake time-travel enables reproducible historical queries: the exact state of training data at any point in time is queryable — essential for Installation Qualification (IQ) and Operational Qualification (OQ) documentation
- MLflow experiments provide full provenance: hyperparameters, dataset version, code version, environment, and output artifacts are logged for every model run
- This directly supports the Computer Software Assurance (CSA) approach recommended by FDA's 2022 guidance: risk-based validation with documented evidence rather than exhaustive testing

**Clinical Trial Data:**
- Unity Catalog for governing patient data (HIPAA compliance: column masking on PHI fields, row filters by study site)
- Delta Sharing for sharing datasets with CROs without data egress — the sponsor retains control; access is revoked by deleting the recipient, not by data retrieval
- MLflow for documenting AI models used in clinical NLP (adverse event detection, protocol deviation identification)

**Key references:**
- Databricks Healthcare & Life Sciences solution accelerators: genomics variant analysis, clinical NLP, adverse event detection, patient risk stratification
- Reference architecture: GxP-compliant lakehouse with Unity Catalog audit trail + Delta Lake immutability + MLflow validation documentation

---

## Discovery Questions

Use these questions to understand the customer's environment and identify where Databricks adds the most value:

1. What does your current data stack look like end-to-end — from raw data ingestion through to analytics and reporting?
2. Where are your biggest data quality or governance pain points today? Who owns data quality enforcement?
3. Do you do any ML or model training in production? Where does that happen — on-prem, SageMaker, Azure ML, or somewhere else?
4. Are you handling real-time or near-real-time data today (streaming, CDC, event-driven pipelines)?
5. What's your cloud posture — all-in on one cloud, multi-cloud, or hybrid with on-prem?
6. Who are your primary data consumers — data scientists writing Python, analysts writing SQL, or business users using BI tools?
7. What's your timeline for any migration, modernization, or new initiative?
8. Are there compliance or regulatory requirements (SOC 2, HIPAA, 21 CFR Part 11, GDPR, FedRAMP) that shape your data architecture choices?
9. What would a successful data platform look like for your team 12 months from now?
10. Who are the internal champions for this initiative, and where do you expect pushback (budget, migration risk, skills gap)?
