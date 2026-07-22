--
-- PostgreSQL database dump
--

\restrict YdJC0XB8UtWWxcYnyvhflxQnoIskgtuOnUtPBs0G5fytcxS97bNFGURhyZyat3a

-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: agent_feedback_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.agent_feedback_status AS ENUM (
    'open',
    'acknowledged',
    'fixed',
    'dismissed'
);


--
-- Name: build_job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.build_job_status AS ENUM (
    'queued',
    'syncing',
    'parsing',
    'synthesizing',
    'validating',
    'ready',
    'published',
    'failed'
);


--
-- Name: team_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.team_role AS ENUM (
    'admin',
    'member',
    'reader'
);


--
-- Name: enforce_knowledge_graph_fact_edge(); Type: FUNCTION; Schema: public; Owner: -
--



--
-- Name: enforce_pipeline_release_provenance(); Type: FUNCTION; Schema: public; Owner: -
--



--
-- Name: enforce_pipeline_search_document_scope(); Type: FUNCTION; Schema: public; Owner: -
--



--
-- Name: enforce_release_provenance_immutable(); Type: FUNCTION; Schema: public; Owner: -
--



--
-- Name: prevent_published_artifact_delete(); Type: FUNCTION; Schema: public; Owner: -
--



--
-- Name: reject_source_analysis_artifact_update(); Type: FUNCTION; Schema: public; Owner: -
--



SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_mfa; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_mfa (
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    encrypted_secret text NOT NULL,
    enabled_at timestamp with time zone,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_mfa_failed_attempts_check CHECK ((failed_attempts >= 0))
);


--
-- Name: admin_mfa_recovery_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_mfa_recovery_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    session_version integer DEFAULT 1 NOT NULL
);


--
-- Name: agent_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    page_id uuid,
    status public.agent_feedback_status DEFAULT 'open'::public.agent_feedback_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    release_id uuid,
    query text NOT NULL,
    reason text NOT NULL,
    expected text,
    rebuild_build_id uuid,
    citations jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    id_hash character(64) NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    csrf_secret_hash character(64) NOT NULL,
    session_version integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: build_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.build_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    build_job_id uuid NOT NULL,
    status public.build_job_status NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sequence bigint NOT NULL
);


--
-- Name: build_events_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.build_events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: build_events_sequence_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.build_events_sequence_seq OWNED BY public.build_events.sequence;


--
-- Name: build_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.build_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    snapshot_id uuid,
    status public.build_job_status DEFAULT 'queued'::public.build_job_status NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    snapshot_path text DEFAULT ''::text NOT NULL,
    commit_sha text DEFAULT ''::text NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    cancel_requested boolean DEFAULT false NOT NULL,
    purpose text DEFAULT 'standard'::text NOT NULL,
    feedback_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    feedback_context jsonb DEFAULT '[]'::jsonb NOT NULL,
    remediation_context jsonb DEFAULT '[]'::jsonb NOT NULL,
    allow_llm boolean DEFAULT false NOT NULL,
    CONSTRAINT build_jobs_build_identity_check CHECK ((((purpose = 'standard'::text) AND (cardinality(feedback_ids) = 0) AND (feedback_context = '[]'::jsonb) AND (remediation_context = '[]'::jsonb)) OR ((purpose = 'feedback'::text) AND (cardinality(feedback_ids) > 0) AND (jsonb_array_length(feedback_context) > 0) AND (remediation_context = '[]'::jsonb)) OR ((purpose = 'remediation'::text) AND (cardinality(feedback_ids) = 0) AND (feedback_context = '[]'::jsonb) AND (jsonb_array_length(remediation_context) > 0)))),
    CONSTRAINT build_jobs_purpose_check CHECK ((purpose = ANY (ARRAY['standard'::text, 'feedback'::text, 'remediation'::text])))
);


--
-- Name: build_stage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.build_stage_events (
    sequence bigint NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    build_job_id uuid NOT NULL,
    stage_run_id uuid NOT NULL,
    stage text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT build_stage_events_stage_check CHECK ((stage = ANY (ARRAY['convert'::text, 'extract'::text, 'tables'::text, 'graph'::text, 'synthesize'::text, 'index'::text, 'lint'::text, 'viz'::text, 'validate'::text, 'package'::text]))),
    CONSTRAINT build_stage_events_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'reused'::text, 'skipped'::text])))
);


--
-- Name: build_stage_events_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.build_stage_events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: build_stage_events_sequence_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.build_stage_events_sequence_seq OWNED BY public.build_stage_events.sequence;


--
-- Name: build_stage_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.build_stage_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    build_job_id uuid NOT NULL,
    stage text NOT NULL,
    attempt integer NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    input_digest character(64) NOT NULL,
    output_manifest_ids uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    error_code text,
    error_detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT build_stage_runs_attempt_check CHECK ((attempt > 0)),
    CONSTRAINT build_stage_runs_input_digest_check CHECK ((input_digest ~ '^[0-9A-Fa-f]{64}$'::text)),
    CONSTRAINT build_stage_runs_stage_check CHECK ((stage = ANY (ARRAY['convert'::text, 'extract'::text, 'tables'::text, 'graph'::text, 'synthesize'::text, 'index'::text, 'lint'::text, 'viz'::text, 'validate'::text, 'package'::text]))),
    CONSTRAINT build_stage_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'reused'::text, 'skipped'::text])))
);


--
-- Name: code_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.code_edges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_symbol_id uuid,
    target_symbol_id uuid,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_name text DEFAULT ''::text NOT NULL,
    target_name text DEFAULT ''::text NOT NULL,
    source_path text DEFAULT ''::text NOT NULL,
    snapshot_id uuid,
    start_line integer DEFAULT 1 NOT NULL,
    end_line integer DEFAULT 1 NOT NULL,
    target_path text
);


--
-- Name: code_symbols; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.code_symbols (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_file_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    signature text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    start_line integer DEFAULT 1 NOT NULL,
    end_line integer DEFAULT 1 NOT NULL,
    exported boolean DEFAULT false NOT NULL
);


--
-- Name: encrypted_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encrypted_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    ciphertext text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    repository_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: import_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    repository_id uuid,
    actor_id uuid,
    source_kind text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    collected_file_count integer DEFAULT 0 NOT NULL,
    collected_text_bytes bigint DEFAULT 0 NOT NULL,
    ignored jsonb DEFAULT '{"total": 0, "reasons": {}}'::jsonb NOT NULL,
    snapshot_id uuid,
    failure_code text,
    upload_session_id uuid,
    CONSTRAINT import_reports_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: knowledge_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    build_job_id uuid NOT NULL,
    stage text NOT NULL,
    kind text NOT NULL,
    schema_version integer NOT NULL,
    input_digest character(64) NOT NULL,
    content_digest character(64) NOT NULL,
    storage_key text NOT NULL,
    source_refs jsonb NOT NULL,
    producer text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_artifacts_content_digest_check CHECK ((content_digest ~ '^[0-9A-Fa-f]{64}$'::text)),
    CONSTRAINT knowledge_artifacts_input_digest_check CHECK ((input_digest ~ '^[0-9A-Fa-f]{64}$'::text)),
    CONSTRAINT knowledge_artifacts_producer_check CHECK ((producer = ANY (ARRAY['deterministic'::text, 'llm'::text]))),
    CONSTRAINT knowledge_artifacts_schema_version_check CHECK ((schema_version > 0)),
    CONSTRAINT knowledge_artifacts_source_refs_check CHECK ((jsonb_typeof(source_refs) = 'array'::text)),
    CONSTRAINT knowledge_artifacts_stage_check CHECK ((stage = ANY (ARRAY['convert'::text, 'extract'::text, 'tables'::text, 'graph'::text, 'synthesize'::text, 'index'::text, 'lint'::text, 'viz'::text, 'validate'::text, 'package'::text])))
);


--
-- Name: knowledge_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    page_id uuid NOT NULL,
    heading text,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    citations jsonb DEFAULT '[]'::jsonb NOT NULL,
    "position" integer NOT NULL,
    CONSTRAINT knowledge_chunks_position_nonnegative CHECK (("position" >= 0))
);


--
-- Name: knowledge_graph_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_graph_edges (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    build_job_id uuid NOT NULL,
    edge_id character(64) NOT NULL,
    from_node_id character(64) NOT NULL,
    to_node_id character(64) NOT NULL,
    kind text NOT NULL,
    candidate boolean DEFAULT false NOT NULL,
    candidate_reason text,
    confidence double precision NOT NULL,
    source_refs jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_graph_edges_check CHECK (((candidate AND (candidate_reason IS NOT NULL) AND (length(candidate_reason) > 0)) OR ((NOT candidate) AND (candidate_reason IS NULL)))),
    CONSTRAINT knowledge_graph_edges_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT knowledge_graph_edges_edge_id_check CHECK ((edge_id ~ '^[0-9A-Fa-f]{64}$'::text)),
    CONSTRAINT knowledge_graph_edges_kind_check CHECK ((kind = ANY (ARRAY['imports'::text, 'exports'::text, 'calls'::text, 'contains'::text, 'documents'::text, 'reads'::text, 'writes'::text, 'depends_on'::text, 'renders'::text, 'routes_to'::text, 'lazy_loads'::text, 'provides'::text, 'injects'::text, 'reads_state'::text, 'writes_state'::text, 'requests'::text, 'subscribes'::text, 'styles'::text, 'visualizes'::text, 'tests'::text, 'configures'::text]))),
    CONSTRAINT knowledge_graph_edges_source_refs_check CHECK ((jsonb_typeof(source_refs) = 'array'::text)),
    CONSTRAINT knowledge_graph_edges_source_refs_check1 CHECK ((jsonb_array_length(source_refs) > 0))
);


--
-- Name: knowledge_graph_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_graph_nodes (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    build_job_id uuid NOT NULL,
    node_id character(64) NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    qualified_name text NOT NULL,
    candidate boolean DEFAULT false NOT NULL,
    source_refs jsonb NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_graph_nodes_attributes_check CHECK ((jsonb_typeof(attributes) = 'object'::text)),
    CONSTRAINT knowledge_graph_nodes_check CHECK ((candidate OR (jsonb_array_length(source_refs) > 0))),
    CONSTRAINT knowledge_graph_nodes_kind_check CHECK ((kind = ANY (ARRAY['module'::text, 'symbol'::text, 'document'::text, 'table'::text, 'column'::text, 'command'::text, 'workspace_package'::text, 'application_entry'::text, 'route'::text, 'layout'::text, 'page'::text, 'component'::text, 'hook_or_composable'::text, 'state_store'::text, 'state_field'::text, 'api_operation'::text, 'data_schema'::text, 'style_token'::text, 'style_scope'::text, 'visualization'::text, 'test_case'::text, 'test_fixture'::text, 'tooling_config'::text]))),
    CONSTRAINT knowledge_graph_nodes_node_id_check CHECK ((node_id ~ '^[0-9A-Fa-f]{64}$'::text)),
    CONSTRAINT knowledge_graph_nodes_source_refs_check CHECK ((jsonb_typeof(source_refs) = 'array'::text))
);


--
-- Name: knowledge_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    build_job_id uuid NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    token_prefix text NOT NULL,
    revoked_at timestamp with time zone,
    project_id uuid,
    scopes text[] DEFAULT ARRAY['search'::text, 'source.read'::text] NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: pipeline_search_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipeline_search_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    build_job_id uuid NOT NULL,
    source_artifact_id uuid NOT NULL,
    document_key text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    citations jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pipeline_search_documents_citations_check CHECK ((jsonb_typeof(citations) = 'array'::text)),
    CONSTRAINT pipeline_search_documents_content_check CHECK ((length(content) > 0)),
    CONSTRAINT pipeline_search_documents_document_key_check CHECK ((length(document_key) > 0)),
    CONSTRAINT pipeline_search_documents_kind_check CHECK ((kind = ANY (ARRAY['page'::text, 'symbol'::text, 'module'::text, 'path'::text, 'table'::text, 'command'::text]))),
    CONSTRAINT pipeline_search_documents_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT pipeline_search_documents_title_check CHECK ((length(title) > 0))
);


--
-- Name: project_frontend_rollouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_frontend_rollouts (
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    mode text DEFAULT 'legacy'::text NOT NULL,
    reason text NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_frontend_rollouts_mode_check CHECK ((mode = ANY (ARRAY['legacy'::text, 'shadow'::text, 'active'::text])))
);


--
-- Name: project_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_members (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.team_role DEFAULT 'reader'::public.team_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: release_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.release_artifacts (
    release_id uuid NOT NULL,
    artifact_id uuid NOT NULL
);


--
-- Name: release_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.release_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    release_id uuid,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: releases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.releases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    build_job_id uuid NOT NULL,
    version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    snapshot_id uuid NOT NULL,
    published_at timestamp with time zone,
    kernel_mode text DEFAULT 'legacy'::text NOT NULL,
    package_artifact_id uuid,
    release_artifact_family text DEFAULT 'knowledge-v1'::text NOT NULL,
    package_stage_run_id uuid,
    frontend_ir_schema_version integer,
    frontend_graph_schema_version integer,
    analyzer_manifest_digest character(64),
    CONSTRAINT releases_frontend_provenance_shape_check CHECK ((((release_artifact_family = 'knowledge-v1'::text) AND (package_stage_run_id IS NULL) AND (frontend_ir_schema_version IS NULL) AND (frontend_graph_schema_version IS NULL) AND (analyzer_manifest_digest IS NULL)) OR ((release_artifact_family = 'frontend-v2'::text) AND (package_stage_run_id IS NOT NULL) AND (package_artifact_id IS NOT NULL) AND (frontend_ir_schema_version = 2) AND (frontend_graph_schema_version = 2) AND (analyzer_manifest_digest ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT releases_kernel_mode_check CHECK ((kernel_mode = ANY (ARRAY['legacy'::text, 'pipeline'::text]))),
    CONSTRAINT releases_release_artifact_family_check CHECK ((release_artifact_family = ANY (ARRAY['knowledge-v1'::text, 'frontend-v2'::text])))
);


--
-- Name: remediation_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remediation_cases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    source_build_id uuid NOT NULL,
    issue jsonb NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    rebuild_build_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    issue_id text NOT NULL,
    CONSTRAINT remediation_cases_issue_check CHECK ((jsonb_typeof(issue) = 'object'::text)),
    CONSTRAINT remediation_cases_state_check CHECK ((state = ANY (ARRAY['open'::text, 'accepted'::text, 'rebuilding'::text, 'resolved'::text, 'dismissed'::text])))
);


--
-- Name: remediation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remediation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence bigint NOT NULL,
    workspace_id uuid NOT NULL,
    remediation_id uuid NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    actor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text,
    CONSTRAINT remediation_events_from_state_check CHECK ((from_state = ANY (ARRAY['open'::text, 'accepted'::text, 'rebuilding'::text, 'resolved'::text, 'dismissed'::text]))),
    CONSTRAINT remediation_events_reason_length_check CHECK (((reason IS NULL) OR (char_length(reason) <= 500))),
    CONSTRAINT remediation_events_to_state_check CHECK ((to_state = ANY (ARRAY['open'::text, 'accepted'::text, 'rebuilding'::text, 'resolved'::text, 'dismissed'::text])))
);


--
-- Name: remediation_events_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.remediation_events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: remediation_events_sequence_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.remediation_events_sequence_seq OWNED BY public.remediation_events.sequence;


--
-- Name: repositories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repositories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    clone_url text,
    default_branch text DEFAULT 'main'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'git'::text NOT NULL,
    local_path text,
    archived_at timestamp with time zone,
    project_id uuid NOT NULL
);


--
-- Name: repository_sync_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repository_sync_schedules (
    repository_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    last_started_at timestamp with time zone,
    last_finished_at timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT repository_sync_schedules_check CHECK (((lease_token IS NULL) = (lease_expires_at IS NULL))),
    CONSTRAINT repository_sync_schedules_failure_count_check CHECK ((failure_count >= 0))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: source_analysis_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_analysis_artifacts (
    workspace_id uuid NOT NULL,
    content_hash character(64) NOT NULL,
    analyzer_id text NOT NULL,
    analyzer_version text NOT NULL,
    parser_config_digest character(64) NOT NULL,
    facts jsonb NOT NULL,
    facts_digest character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_analysis_artifacts_analyzer_id_check CHECK ((analyzer_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'::text)),
    CONSTRAINT source_analysis_artifacts_analyzer_version_check CHECK ((analyzer_version ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$'::text)),
    CONSTRAINT source_analysis_artifacts_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT source_analysis_artifacts_facts_digest_check CHECK ((facts_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT source_analysis_artifacts_facts_object_check CHECK ((jsonb_typeof(facts) = 'object'::text)),
    CONSTRAINT source_analysis_artifacts_facts_size_check CHECK ((octet_length((facts)::text) <= 8388608)),
    CONSTRAINT source_analysis_artifacts_parser_config_digest_check CHECK ((parser_config_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: source_blobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_blobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    content_hash text NOT NULL,
    generation integer NOT NULL,
    byte_size bigint NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    storage_key text NOT NULL,
    fencing_token uuid,
    tombstoned_at timestamp with time zone,
    trashed_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_blobs_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT source_blobs_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT source_blobs_generation_check CHECK ((generation > 0)),
    CONSTRAINT source_blobs_status_check CHECK ((status = ANY (ARRAY['active'::text, 'tombstoned'::text, 'trash'::text, 'deleted'::text])))
);


--
-- Name: source_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    path text NOT NULL,
    language text,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    byte_size integer DEFAULT 0 NOT NULL,
    source_blob_id uuid NOT NULL
);


--
-- Name: source_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    commit_sha text NOT NULL,
    ref text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    remote_url text,
    commit_timestamp timestamp with time zone DEFAULT now() NOT NULL,
    storage_path text DEFAULT ''::text NOT NULL,
    pending_upload_session_id uuid,
    pending_import_report_id uuid
);


--
-- Name: upload_idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_idempotency_keys (
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    operation text NOT NULL,
    request_digest text NOT NULL,
    session_id uuid,
    response_status integer NOT NULL,
    response_body jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT upload_idempotency_keys_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 200))),
    CONSTRAINT upload_idempotency_keys_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT upload_idempotency_keys_response_status_check CHECK (((response_status >= 200) AND (response_status <= 599)))
);


--
-- Name: upload_session_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_session_entries (
    session_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    ordinal integer NOT NULL,
    path text NOT NULL,
    kind text NOT NULL,
    byte_size bigint NOT NULL,
    content_hash text,
    media_type text,
    metadata_byte_size integer NOT NULL,
    disposition text NOT NULL,
    trust text NOT NULL,
    ignore_reason text,
    uploaded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_session_entries_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT upload_session_entries_content_hash_check CHECK ((((kind = 'source'::text) AND (content_hash ~ '^[0-9a-f]{64}$'::text)) OR ((kind = 'asset'::text) AND (content_hash IS NULL)))),
    CONSTRAINT upload_session_entries_disposition_check CHECK ((disposition = ANY (ARRAY['upload_required'::text, 'metadata_only'::text, 'ignored'::text]))),
    CONSTRAINT upload_session_entries_kind_check CHECK ((kind = ANY (ARRAY['source'::text, 'asset'::text]))),
    CONSTRAINT upload_session_entries_metadata_byte_size_check CHECK ((metadata_byte_size > 0)),
    CONSTRAINT upload_session_entries_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT upload_session_entries_path_check CHECK (((octet_length(path) >= 1) AND (octet_length(path) <= 4096))),
    CONSTRAINT upload_session_entries_state_check CHECK ((((disposition = 'upload_required'::text) AND (trust = ANY (ARRAY['pending'::text, 'server_verified'::text])) AND (ignore_reason IS NULL)) OR ((disposition = 'metadata_only'::text) AND (trust = 'client_unverified'::text) AND (ignore_reason IS NULL)) OR ((disposition = 'ignored'::text) AND (ignore_reason IS NOT NULL)))),
    CONSTRAINT upload_session_entries_trust_check CHECK ((trust = ANY (ARRAY['pending'::text, 'server_verified'::text, 'client_unverified'::text])))
);


--
-- Name: upload_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    session_version integer NOT NULL,
    is_replacement boolean NOT NULL,
    expected_current_repository_id uuid NOT NULL,
    expected_latest_snapshot_id uuid,
    status text DEFAULT 'open'::text NOT NULL,
    entry_count integer NOT NULL,
    manifest_digest text,
    snapshot_id uuid,
    commit_response jsonb,
    expires_at timestamp with time zone NOT NULL,
    committed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_sessions_entry_count_check CHECK (((entry_count >= 1) AND (entry_count <= 100000))),
    CONSTRAINT upload_sessions_manifest_digest_check CHECK (((manifest_digest IS NULL) OR (manifest_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT upload_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'committing'::text, 'committed'::text, 'cancelled'::text]))),
    CONSTRAINT upload_sessions_terminal_shape_check CHECK ((((status = 'committed'::text) AND (manifest_digest IS NOT NULL) AND (snapshot_id IS NOT NULL) AND (commit_response IS NOT NULL) AND (committed_at IS NOT NULL)) OR ((status = 'cancelled'::text) AND (cancelled_at IS NOT NULL)) OR (status = ANY (ARRAY['open'::text, 'committing'::text]))))
);


--
-- Name: workspace_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_members (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.team_role DEFAULT 'member'::public.team_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: build_events sequence; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_events ALTER COLUMN sequence SET DEFAULT nextval('public.build_events_sequence_seq'::regclass);


--
-- Name: build_stage_events sequence; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_events ALTER COLUMN sequence SET DEFAULT nextval('public.build_stage_events_sequence_seq'::regclass);


--
-- Name: remediation_events sequence; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_events ALTER COLUMN sequence SET DEFAULT nextval('public.remediation_events_sequence_seq'::regclass);


--
-- Name: admin_mfa admin_mfa_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_mfa
    ADD CONSTRAINT admin_mfa_pkey PRIMARY KEY (user_id);


--
-- Name: admin_mfa_recovery_codes admin_mfa_recovery_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_mfa_recovery_codes
    ADD CONSTRAINT admin_mfa_recovery_codes_pkey PRIMARY KEY (id);


--
-- Name: admin_mfa_recovery_codes admin_mfa_recovery_codes_user_id_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_mfa_recovery_codes
    ADD CONSTRAINT admin_mfa_recovery_codes_user_id_code_hash_key UNIQUE (user_id, code_hash);


--
-- Name: admin_users admin_users_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);


--
-- Name: agent_feedback agent_feedback_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_feedback
    ADD CONSTRAINT agent_feedback_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: agent_feedback agent_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_feedback
    ADD CONSTRAINT agent_feedback_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id_hash);


--
-- Name: build_events build_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_events
    ADD CONSTRAINT build_events_pkey PRIMARY KEY (id);


--
-- Name: build_jobs build_jobs_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_jobs
    ADD CONSTRAINT build_jobs_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: build_jobs build_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_jobs
    ADD CONSTRAINT build_jobs_pkey PRIMARY KEY (id);


--
-- Name: build_stage_events build_stage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_events
    ADD CONSTRAINT build_stage_events_pkey PRIMARY KEY (sequence);


--
-- Name: build_stage_events build_stage_events_stage_run_id_status_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_events
    ADD CONSTRAINT build_stage_events_stage_run_id_status_key UNIQUE (stage_run_id, status);


--
-- Name: build_stage_runs build_stage_runs_build_job_id_stage_attempt_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_runs
    ADD CONSTRAINT build_stage_runs_build_job_id_stage_attempt_key UNIQUE (build_job_id, stage, attempt);


--
-- Name: build_stage_runs build_stage_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_runs
    ADD CONSTRAINT build_stage_runs_pkey PRIMARY KEY (id);


--
-- Name: code_edges code_edges_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_edges
    ADD CONSTRAINT code_edges_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: code_edges code_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_edges
    ADD CONSTRAINT code_edges_pkey PRIMARY KEY (id);


--
-- Name: code_symbols code_symbols_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_symbols
    ADD CONSTRAINT code_symbols_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: code_symbols code_symbols_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_symbols
    ADD CONSTRAINT code_symbols_pkey PRIMARY KEY (id);


--
-- Name: encrypted_credentials encrypted_credentials_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encrypted_credentials
    ADD CONSTRAINT encrypted_credentials_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: encrypted_credentials encrypted_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encrypted_credentials
    ADD CONSTRAINT encrypted_credentials_pkey PRIMARY KEY (id);


--
-- Name: import_reports import_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_reports
    ADD CONSTRAINT import_reports_pkey PRIMARY KEY (id);


--
-- Name: knowledge_artifacts knowledge_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_artifacts
    ADD CONSTRAINT knowledge_artifacts_pkey PRIMARY KEY (id);


--
-- Name: knowledge_artifacts knowledge_artifacts_project_id_snapshot_id_stage_kind_input_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_artifacts
    ADD CONSTRAINT knowledge_artifacts_project_id_snapshot_id_stage_kind_input_key UNIQUE (project_id, snapshot_id, stage, kind, input_digest);


--
-- Name: knowledge_artifacts knowledge_artifacts_storage_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_artifacts
    ADD CONSTRAINT knowledge_artifacts_storage_key_key UNIQUE (storage_key);


--
-- Name: knowledge_chunks knowledge_chunks_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: knowledge_chunks knowledge_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_pkey PRIMARY KEY (id);


--
-- Name: knowledge_graph_edges knowledge_graph_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_pkey PRIMARY KEY (build_job_id, edge_id);


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_pkey PRIMARY KEY (build_job_id, node_id);


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_workspace_id_project_id_snapshot_id_b_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_workspace_id_project_id_snapshot_id_b_key UNIQUE (workspace_id, project_id, snapshot_id, build_job_id, node_id);


--
-- Name: knowledge_pages knowledge_pages_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_pages
    ADD CONSTRAINT knowledge_pages_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: knowledge_pages knowledge_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_pages
    ADD CONSTRAINT knowledge_pages_pkey PRIMARY KEY (id);


--
-- Name: mcp_tokens mcp_tokens_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: mcp_tokens mcp_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_pkey PRIMARY KEY (id);


--
-- Name: pipeline_search_documents pipeline_search_documents_build_artifact_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_search_documents
    ADD CONSTRAINT pipeline_search_documents_build_artifact_key UNIQUE (build_job_id, source_artifact_id, document_key);


--
-- Name: pipeline_search_documents pipeline_search_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_search_documents
    ADD CONSTRAINT pipeline_search_documents_pkey PRIMARY KEY (id);


--
-- Name: project_frontend_rollouts project_frontend_rollouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_frontend_rollouts
    ADD CONSTRAINT project_frontend_rollouts_pkey PRIMARY KEY (project_id);


--
-- Name: project_members project_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (project_id, user_id);


--
-- Name: projects projects_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: release_artifacts release_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_artifacts
    ADD CONSTRAINT release_artifacts_pkey PRIMARY KEY (release_id, artifact_id);


--
-- Name: release_channels release_channels_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_channels
    ADD CONSTRAINT release_channels_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: release_channels release_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_channels
    ADD CONSTRAINT release_channels_pkey PRIMARY KEY (id);


--
-- Name: releases releases_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: releases releases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_pkey PRIMARY KEY (id);


--
-- Name: remediation_cases remediation_cases_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_cases
    ADD CONSTRAINT remediation_cases_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: remediation_cases remediation_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_cases
    ADD CONSTRAINT remediation_cases_pkey PRIMARY KEY (id);


--
-- Name: remediation_cases remediation_cases_source_issue_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_cases
    ADD CONSTRAINT remediation_cases_source_issue_unique UNIQUE (workspace_id, source_build_id, issue_id);


--
-- Name: remediation_events remediation_events_dismissal_reason_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.remediation_events
    ADD CONSTRAINT remediation_events_dismissal_reason_check CHECK (((to_state <> 'dismissed'::text) OR ((reason IS NOT NULL) AND (btrim(reason) <> ''::text)))) NOT VALID;


--
-- Name: remediation_events remediation_events_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_events
    ADD CONSTRAINT remediation_events_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: remediation_events remediation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_events
    ADD CONSTRAINT remediation_events_pkey PRIMARY KEY (id);


--
-- Name: repositories repositories_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: repositories repositories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_pkey PRIMARY KEY (id);


--
-- Name: repository_sync_schedules repository_sync_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_sync_schedules
    ADD CONSTRAINT repository_sync_schedules_pkey PRIMARY KEY (repository_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: source_analysis_artifacts source_analysis_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_analysis_artifacts
    ADD CONSTRAINT source_analysis_artifacts_pkey PRIMARY KEY (workspace_id, content_hash, analyzer_id, analyzer_version, parser_config_digest);


--
-- Name: source_blobs source_blobs_id_workspace_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_blobs
    ADD CONSTRAINT source_blobs_id_workspace_unique UNIQUE (id, workspace_id);


--
-- Name: source_blobs source_blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_blobs
    ADD CONSTRAINT source_blobs_pkey PRIMARY KEY (id);


--
-- Name: source_blobs source_blobs_reference_identity_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_blobs
    ADD CONSTRAINT source_blobs_reference_identity_unique UNIQUE (id, workspace_id, content_hash, byte_size);


--
-- Name: source_blobs source_blobs_workspace_hash_generation_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_blobs
    ADD CONSTRAINT source_blobs_workspace_hash_generation_unique UNIQUE (workspace_id, content_hash, generation);


--
-- Name: source_files source_files_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_files
    ADD CONSTRAINT source_files_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: source_files source_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_files
    ADD CONSTRAINT source_files_pkey PRIMARY KEY (id);


--
-- Name: source_snapshots source_snapshots_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: source_snapshots source_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_pkey PRIMARY KEY (id);


--
-- Name: upload_idempotency_keys upload_idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_idempotency_keys
    ADD CONSTRAINT upload_idempotency_keys_pkey PRIMARY KEY (workspace_id, actor_id, idempotency_key);


--
-- Name: upload_session_entries upload_session_entries_path_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_session_entries
    ADD CONSTRAINT upload_session_entries_path_unique UNIQUE (session_id, path);


--
-- Name: upload_session_entries upload_session_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_session_entries
    ADD CONSTRAINT upload_session_entries_pkey PRIMARY KEY (session_id, ordinal);


--
-- Name: upload_sessions upload_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_pkey PRIMARY KEY (id);


--
-- Name: upload_sessions upload_sessions_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_scope_unique UNIQUE (id, workspace_id, project_id, repository_id, actor_id);


--
-- Name: workspace_members workspace_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: admin_mfa_recovery_codes_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_mfa_recovery_codes_active_idx ON public.admin_mfa_recovery_codes USING btree (user_id) WHERE (used_at IS NULL);


--
-- Name: admin_mfa_workspace_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_mfa_workspace_enabled_idx ON public.admin_mfa USING btree (workspace_id, enabled_at) WHERE (enabled_at IS NOT NULL);


--
-- Name: admin_users_workspace_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_users_workspace_active_idx ON public.admin_users USING btree (workspace_id, disabled_at) WHERE (disabled_at IS NULL);


--
-- Name: admin_users_workspace_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admin_users_workspace_email_idx ON public.admin_users USING btree (workspace_id, email);


--
-- Name: agent_feedback_workspace_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_feedback_workspace_status_idx ON public.agent_feedback USING btree (workspace_id, status);


--
-- Name: audit_events_workspace_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_workspace_created_idx ON public.audit_events USING btree (workspace_id, created_at);


--
-- Name: auth_sessions_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_user_active_idx ON public.auth_sessions USING btree (user_id, expires_at) WHERE (revoked_at IS NULL);


--
-- Name: build_events_build_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX build_events_build_created_idx ON public.build_events USING btree (build_job_id, created_at);


--
-- Name: build_events_sequence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX build_events_sequence_idx ON public.build_events USING btree (sequence);


--
-- Name: build_jobs_identity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX build_jobs_identity_idx ON public.build_jobs USING btree (workspace_id, repository_id, snapshot_id, purpose, feedback_ids);


--
-- Name: build_jobs_workspace_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX build_jobs_workspace_status_idx ON public.build_jobs USING btree (workspace_id, status);


--
-- Name: build_stage_events_replay_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX build_stage_events_replay_idx ON public.build_stage_events USING btree (workspace_id, project_id, build_job_id, sequence);


--
-- Name: build_stage_runs_available_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX build_stage_runs_available_claim_idx ON public.build_stage_runs USING btree (status, available_at, created_at, id);


--
-- Name: build_stage_runs_build_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX build_stage_runs_build_idx ON public.build_stage_runs USING btree (workspace_id, build_job_id, stage, attempt);


--
-- Name: build_stage_runs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX build_stage_runs_claim_idx ON public.build_stage_runs USING btree (workspace_id, project_id, status, created_at, id);


--
-- Name: code_edges_snapshot_identity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX code_edges_snapshot_identity_idx ON public.code_edges USING btree (snapshot_id, kind, source_name, target_name, source_path, start_line, end_line);


--
-- Name: code_edges_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX code_edges_snapshot_idx ON public.code_edges USING btree (snapshot_id);


--
-- Name: code_edges_workspace_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX code_edges_workspace_source_idx ON public.code_edges USING btree (workspace_id, source_symbol_id);


--
-- Name: code_symbols_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX code_symbols_name_trgm_idx ON public.code_symbols USING gin (lower(name) public.gin_trgm_ops);


--
-- Name: code_symbols_source_identity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX code_symbols_source_identity_idx ON public.code_symbols USING btree (source_file_id, kind, name, start_line, end_line);


--
-- Name: code_symbols_workspace_file_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX code_symbols_workspace_file_idx ON public.code_symbols USING btree (workspace_id, source_file_id);


--
-- Name: encrypted_credentials_repo_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX encrypted_credentials_repo_name_idx ON public.encrypted_credentials USING btree (repository_id, name);


--
-- Name: encrypted_credentials_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX encrypted_credentials_workspace_idx ON public.encrypted_credentials USING btree (workspace_id);


--
-- Name: encrypted_credentials_workspace_model_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX encrypted_credentials_workspace_model_idx ON public.encrypted_credentials USING btree (workspace_id, name) WHERE (repository_id IS NULL);


--
-- Name: import_reports_id_workspace_repository_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX import_reports_id_workspace_repository_idx ON public.import_reports USING btree (id, workspace_id, repository_id);


--
-- Name: import_reports_project_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_reports_project_started_idx ON public.import_reports USING btree (workspace_id, project_id, started_at DESC, id DESC);


--
-- Name: import_reports_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_reports_retention_idx ON public.import_reports USING btree (status, finished_at) WHERE (status = ANY (ARRAY['failed'::text, 'cancelled'::text]));


--
-- Name: import_reports_upload_session_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX import_reports_upload_session_unique_idx ON public.import_reports USING btree (upload_session_id) WHERE (upload_session_id IS NOT NULL);


--
-- Name: knowledge_artifacts_build_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_artifacts_build_idx ON public.knowledge_artifacts USING btree (workspace_id, project_id, build_job_id, stage, created_at);


--
-- Name: knowledge_artifacts_cache_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_artifacts_cache_idx ON public.knowledge_artifacts USING btree (workspace_id, project_id, snapshot_id, stage, kind, input_digest);


--
-- Name: knowledge_chunks_page_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX knowledge_chunks_page_position_idx ON public.knowledge_chunks USING btree (page_id, "position");


--
-- Name: knowledge_chunks_workspace_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_chunks_workspace_page_idx ON public.knowledge_chunks USING btree (workspace_id, page_id);


--
-- Name: knowledge_graph_edges_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_graph_edges_scope_idx ON public.knowledge_graph_edges USING btree (workspace_id, project_id, snapshot_id, build_job_id, from_node_id, kind);


--
-- Name: knowledge_graph_nodes_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_graph_nodes_scope_idx ON public.knowledge_graph_nodes USING btree (workspace_id, project_id, snapshot_id, build_job_id, kind, qualified_name);


--
-- Name: knowledge_pages_build_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX knowledge_pages_build_slug_idx ON public.knowledge_pages USING btree (build_job_id, slug);


--
-- Name: knowledge_pages_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_pages_search_idx ON public.knowledge_pages USING gin (to_tsvector('english'::regconfig, ((title || ' '::text) || body)));


--
-- Name: knowledge_pages_text_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_pages_text_trgm_idx ON public.knowledge_pages USING gin (lower(((title || ' '::text) || body)) public.gin_trgm_ops);


--
-- Name: mcp_tokens_active_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tokens_active_hash_idx ON public.mcp_tokens USING btree (token_hash, expires_at) WHERE (revoked_at IS NULL);


--
-- Name: mcp_tokens_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_tokens_hash_idx ON public.mcp_tokens USING btree (token_hash);


--
-- Name: mcp_tokens_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tokens_workspace_idx ON public.mcp_tokens USING btree (workspace_id);


--
-- Name: mcp_tokens_workspace_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tokens_workspace_project_idx ON public.mcp_tokens USING btree (workspace_id, project_id);


--
-- Name: pipeline_search_documents_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pipeline_search_documents_scope_idx ON public.pipeline_search_documents USING btree (workspace_id, project_id, build_job_id, kind, document_key);


--
-- Name: project_frontend_rollouts_workspace_mode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_frontend_rollouts_workspace_mode_idx ON public.project_frontend_rollouts USING btree (workspace_id, mode, project_id);


--
-- Name: project_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_members_user_idx ON public.project_members USING btree (user_id, project_id);


--
-- Name: projects_workspace_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX projects_workspace_active_idx ON public.projects USING btree (workspace_id, archived_at);


--
-- Name: projects_workspace_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX projects_workspace_slug_idx ON public.projects USING btree (workspace_id, slug);


--
-- Name: release_artifacts_artifact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX release_artifacts_artifact_idx ON public.release_artifacts USING btree (artifact_id, release_id);


--
-- Name: release_channels_repository_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX release_channels_repository_name_idx ON public.release_channels USING btree (repository_id, name);


--
-- Name: releases_repository_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX releases_repository_version_idx ON public.releases USING btree (repository_id, version);


--
-- Name: remediation_cases_project_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX remediation_cases_project_state_idx ON public.remediation_cases USING btree (workspace_id, project_id, state, created_at DESC);


--
-- Name: remediation_events_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX remediation_events_case_idx ON public.remediation_events USING btree (workspace_id, remediation_id, sequence);


--
-- Name: repositories_id_workspace_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX repositories_id_workspace_project_idx ON public.repositories USING btree (id, workspace_id, project_id);


--
-- Name: repositories_project_current_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX repositories_project_current_unique_idx ON public.repositories USING btree (project_id) WHERE (archived_at IS NULL);


--
-- Name: repositories_workspace_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX repositories_workspace_project_idx ON public.repositories USING btree (workspace_id, project_id);


--
-- Name: repository_sync_schedules_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX repository_sync_schedules_due_idx ON public.repository_sync_schedules USING btree (next_attempt_at, repository_id);


--
-- Name: source_blobs_live_workspace_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_blobs_live_workspace_hash_idx ON public.source_blobs USING btree (workspace_id, content_hash) WHERE (status = ANY (ARRAY['active'::text, 'tombstoned'::text]));


--
-- Name: source_blobs_workspace_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_blobs_workspace_status_idx ON public.source_blobs USING btree (workspace_id, status, updated_at);


--
-- Name: source_files_path_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_files_path_trgm_idx ON public.source_files USING gin (lower(path) public.gin_trgm_ops);


--
-- Name: source_files_snapshot_path_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_files_snapshot_path_idx ON public.source_files USING btree (snapshot_id, path);


--
-- Name: source_files_source_blob_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_files_source_blob_idx ON public.source_files USING btree (source_blob_id);


--
-- Name: source_snapshots_id_workspace_repository_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_snapshots_id_workspace_repository_idx ON public.source_snapshots USING btree (id, workspace_id, repository_id);


--
-- Name: source_snapshots_pending_import_report_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_snapshots_pending_import_report_unique_idx ON public.source_snapshots USING btree (pending_import_report_id) WHERE (pending_import_report_id IS NOT NULL);


--
-- Name: source_snapshots_pending_upload_session_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_snapshots_pending_upload_session_unique_idx ON public.source_snapshots USING btree (pending_upload_session_id) WHERE (pending_upload_session_id IS NOT NULL);


--
-- Name: source_snapshots_repo_commit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_snapshots_repo_commit_idx ON public.source_snapshots USING btree (repository_id, commit_sha) WHERE ((pending_upload_session_id IS NULL) AND (pending_import_report_id IS NULL));


--
-- Name: source_snapshots_workspace_repo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_snapshots_workspace_repo_idx ON public.source_snapshots USING btree (workspace_id, repository_id);


--
-- Name: upload_idempotency_keys_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upload_idempotency_keys_expiry_idx ON public.upload_idempotency_keys USING btree (expires_at);


--
-- Name: upload_sessions_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upload_sessions_expiry_idx ON public.upload_sessions USING btree (expires_at) WHERE (status = ANY (ARRAY['open'::text, 'committing'::text, 'committed'::text, 'cancelled'::text]));


--
-- Name: upload_sessions_id_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX upload_sessions_id_workspace_idx ON public.upload_sessions USING btree (id, workspace_id);


--
-- Name: upload_sessions_project_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upload_sessions_project_created_idx ON public.upload_sessions USING btree (workspace_id, project_id, created_at DESC);


--
-- Name: workspace_members_workspace_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_members_workspace_role_idx ON public.workspace_members USING btree (workspace_id, role);


--
-- Name: workspaces_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspaces_slug_idx ON public.workspaces USING btree (slug);


--
-- Name: knowledge_artifacts knowledge_artifacts_prevent_published_delete; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: knowledge_graph_edges knowledge_graph_fact_edge_integrity; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: pipeline_search_documents pipeline_search_documents_scope_integrity; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: releases releases_pipeline_provenance_immutable; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: releases releases_pipeline_provenance_integrity; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: source_analysis_artifacts source_analysis_artifacts_immutable; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: admin_mfa_recovery_codes admin_mfa_recovery_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_mfa_recovery_codes
    ADD CONSTRAINT admin_mfa_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.admin_users(id) ON DELETE CASCADE;


--
-- Name: admin_mfa_recovery_codes admin_mfa_recovery_codes_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_mfa_recovery_codes
    ADD CONSTRAINT admin_mfa_recovery_codes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: admin_mfa admin_mfa_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_mfa
    ADD CONSTRAINT admin_mfa_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.admin_users(id) ON DELETE CASCADE;


--
-- Name: admin_mfa admin_mfa_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_mfa
    ADD CONSTRAINT admin_mfa_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: admin_users admin_users_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: agent_feedback agent_feedback_page_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_feedback
    ADD CONSTRAINT agent_feedback_page_id_workspace_id_fkey FOREIGN KEY (page_id, workspace_id) REFERENCES public.knowledge_pages(id, workspace_id);


--
-- Name: agent_feedback agent_feedback_rebuild_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_feedback
    ADD CONSTRAINT agent_feedback_rebuild_workspace_fk FOREIGN KEY (rebuild_build_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id);


--
-- Name: agent_feedback agent_feedback_release_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_feedback
    ADD CONSTRAINT agent_feedback_release_workspace_fk FOREIGN KEY (release_id, workspace_id) REFERENCES public.releases(id, workspace_id);


--
-- Name: agent_feedback agent_feedback_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_feedback
    ADD CONSTRAINT agent_feedback_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: audit_events audit_events_actor_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_id_workspace_id_fkey FOREIGN KEY (actor_id, workspace_id) REFERENCES public.admin_users(id, workspace_id);


--
-- Name: audit_events audit_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: auth_sessions auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.admin_users(id) ON DELETE CASCADE;


--
-- Name: auth_sessions auth_sessions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: build_events build_events_build_job_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_events
    ADD CONSTRAINT build_events_build_job_id_workspace_id_fkey FOREIGN KEY (build_job_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id) ON DELETE CASCADE;


--
-- Name: build_events build_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_events
    ADD CONSTRAINT build_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: build_jobs build_jobs_repository_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_jobs
    ADD CONSTRAINT build_jobs_repository_id_workspace_id_fkey FOREIGN KEY (repository_id, workspace_id) REFERENCES public.repositories(id, workspace_id) ON DELETE CASCADE;


--
-- Name: build_jobs build_jobs_snapshot_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_jobs
    ADD CONSTRAINT build_jobs_snapshot_id_workspace_id_fkey FOREIGN KEY (snapshot_id, workspace_id) REFERENCES public.source_snapshots(id, workspace_id);


--
-- Name: build_jobs build_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_jobs
    ADD CONSTRAINT build_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: build_stage_events build_stage_events_build_job_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_events
    ADD CONSTRAINT build_stage_events_build_job_id_workspace_id_fkey FOREIGN KEY (build_job_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id) ON DELETE CASCADE;


--
-- Name: build_stage_events build_stage_events_project_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_events
    ADD CONSTRAINT build_stage_events_project_id_workspace_id_fkey FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE;


--
-- Name: build_stage_events build_stage_events_stage_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_events
    ADD CONSTRAINT build_stage_events_stage_run_id_fkey FOREIGN KEY (stage_run_id) REFERENCES public.build_stage_runs(id) ON DELETE CASCADE;


--
-- Name: build_stage_events build_stage_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_events
    ADD CONSTRAINT build_stage_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: build_stage_runs build_stage_runs_build_job_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_runs
    ADD CONSTRAINT build_stage_runs_build_job_id_workspace_id_fkey FOREIGN KEY (build_job_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id) ON DELETE CASCADE;


--
-- Name: build_stage_runs build_stage_runs_project_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_runs
    ADD CONSTRAINT build_stage_runs_project_id_workspace_id_fkey FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE;


--
-- Name: build_stage_runs build_stage_runs_snapshot_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_runs
    ADD CONSTRAINT build_stage_runs_snapshot_id_workspace_id_fkey FOREIGN KEY (snapshot_id, workspace_id) REFERENCES public.source_snapshots(id, workspace_id) ON DELETE CASCADE;


--
-- Name: build_stage_runs build_stage_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_stage_runs
    ADD CONSTRAINT build_stage_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: code_edges code_edges_snapshot_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_edges
    ADD CONSTRAINT code_edges_snapshot_workspace_fk FOREIGN KEY (snapshot_id, workspace_id) REFERENCES public.source_snapshots(id, workspace_id) ON DELETE CASCADE;


--
-- Name: code_edges code_edges_source_symbol_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_edges
    ADD CONSTRAINT code_edges_source_symbol_id_workspace_id_fkey FOREIGN KEY (source_symbol_id, workspace_id) REFERENCES public.code_symbols(id, workspace_id) ON DELETE CASCADE;


--
-- Name: code_edges code_edges_target_symbol_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_edges
    ADD CONSTRAINT code_edges_target_symbol_id_workspace_id_fkey FOREIGN KEY (target_symbol_id, workspace_id) REFERENCES public.code_symbols(id, workspace_id) ON DELETE CASCADE;


--
-- Name: code_edges code_edges_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_edges
    ADD CONSTRAINT code_edges_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: code_symbols code_symbols_source_file_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_symbols
    ADD CONSTRAINT code_symbols_source_file_id_workspace_id_fkey FOREIGN KEY (source_file_id, workspace_id) REFERENCES public.source_files(id, workspace_id) ON DELETE CASCADE;


--
-- Name: code_symbols code_symbols_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_symbols
    ADD CONSTRAINT code_symbols_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: encrypted_credentials encrypted_credentials_repository_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encrypted_credentials
    ADD CONSTRAINT encrypted_credentials_repository_workspace_fk FOREIGN KEY (repository_id, workspace_id) REFERENCES public.repositories(id, workspace_id) ON DELETE CASCADE;


--
-- Name: encrypted_credentials encrypted_credentials_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encrypted_credentials
    ADD CONSTRAINT encrypted_credentials_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: import_reports import_reports_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_reports
    ADD CONSTRAINT import_reports_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: import_reports import_reports_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_reports
    ADD CONSTRAINT import_reports_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: import_reports import_reports_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_reports
    ADD CONSTRAINT import_reports_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE SET NULL;


--
-- Name: import_reports import_reports_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_reports
    ADD CONSTRAINT import_reports_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.source_snapshots(id) ON DELETE SET NULL;


--
-- Name: import_reports import_reports_upload_session_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_reports
    ADD CONSTRAINT import_reports_upload_session_scope_fk FOREIGN KEY (upload_session_id, workspace_id, project_id, repository_id, actor_id) REFERENCES public.upload_sessions(id, workspace_id, project_id, repository_id, actor_id);


--
-- Name: import_reports import_reports_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_reports
    ADD CONSTRAINT import_reports_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: knowledge_artifacts knowledge_artifacts_build_job_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_artifacts
    ADD CONSTRAINT knowledge_artifacts_build_job_id_workspace_id_fkey FOREIGN KEY (build_job_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id) ON DELETE RESTRICT;


--
-- Name: knowledge_artifacts knowledge_artifacts_project_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_artifacts
    ADD CONSTRAINT knowledge_artifacts_project_id_workspace_id_fkey FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE;


--
-- Name: knowledge_artifacts knowledge_artifacts_snapshot_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_artifacts
    ADD CONSTRAINT knowledge_artifacts_snapshot_id_workspace_id_fkey FOREIGN KEY (snapshot_id, workspace_id) REFERENCES public.source_snapshots(id, workspace_id) ON DELETE CASCADE;


--
-- Name: knowledge_artifacts knowledge_artifacts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_artifacts
    ADD CONSTRAINT knowledge_artifacts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: knowledge_chunks knowledge_chunks_page_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_page_id_workspace_id_fkey FOREIGN KEY (page_id, workspace_id) REFERENCES public.knowledge_pages(id, workspace_id) ON DELETE CASCADE;


--
-- Name: knowledge_chunks knowledge_chunks_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_edges knowledge_graph_edges_build_job_id_from_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_build_job_id_from_node_id_fkey FOREIGN KEY (build_job_id, from_node_id) REFERENCES public.knowledge_graph_nodes(build_job_id, node_id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_edges knowledge_graph_edges_build_job_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_build_job_id_workspace_id_fkey FOREIGN KEY (build_job_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_edges knowledge_graph_edges_project_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_project_id_workspace_id_fkey FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_edges knowledge_graph_edges_snapshot_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_snapshot_id_workspace_id_fkey FOREIGN KEY (snapshot_id, workspace_id) REFERENCES public.source_snapshots(id, workspace_id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_edges knowledge_graph_edges_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_edges
    ADD CONSTRAINT knowledge_graph_edges_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_build_job_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_build_job_id_workspace_id_fkey FOREIGN KEY (build_job_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_project_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_project_id_workspace_id_fkey FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_snapshot_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_snapshot_id_workspace_id_fkey FOREIGN KEY (snapshot_id, workspace_id) REFERENCES public.source_snapshots(id, workspace_id) ON DELETE CASCADE;


--
-- Name: knowledge_graph_nodes knowledge_graph_nodes_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_graph_nodes
    ADD CONSTRAINT knowledge_graph_nodes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: knowledge_pages knowledge_pages_build_job_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_pages
    ADD CONSTRAINT knowledge_pages_build_job_id_workspace_id_fkey FOREIGN KEY (build_job_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id) ON DELETE CASCADE;


--
-- Name: knowledge_pages knowledge_pages_repository_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_pages
    ADD CONSTRAINT knowledge_pages_repository_id_workspace_id_fkey FOREIGN KEY (repository_id, workspace_id) REFERENCES public.repositories(id, workspace_id) ON DELETE CASCADE;


--
-- Name: knowledge_pages knowledge_pages_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_pages
    ADD CONSTRAINT knowledge_pages_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: mcp_tokens mcp_tokens_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: pipeline_search_documents pipeline_search_documents_build_job_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_search_documents
    ADD CONSTRAINT pipeline_search_documents_build_job_id_workspace_id_fkey FOREIGN KEY (build_job_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id) ON DELETE CASCADE;


--
-- Name: pipeline_search_documents pipeline_search_documents_project_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_search_documents
    ADD CONSTRAINT pipeline_search_documents_project_id_workspace_id_fkey FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE;


--
-- Name: pipeline_search_documents pipeline_search_documents_snapshot_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_search_documents
    ADD CONSTRAINT pipeline_search_documents_snapshot_id_workspace_id_fkey FOREIGN KEY (snapshot_id, workspace_id) REFERENCES public.source_snapshots(id, workspace_id) ON DELETE CASCADE;


--
-- Name: pipeline_search_documents pipeline_search_documents_source_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_search_documents
    ADD CONSTRAINT pipeline_search_documents_source_artifact_id_fkey FOREIGN KEY (source_artifact_id) REFERENCES public.knowledge_artifacts(id) ON DELETE CASCADE;


--
-- Name: pipeline_search_documents pipeline_search_documents_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_search_documents
    ADD CONSTRAINT pipeline_search_documents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: project_frontend_rollouts project_frontend_rollouts_project_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_frontend_rollouts
    ADD CONSTRAINT project_frontend_rollouts_project_id_workspace_id_fkey FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE;


--
-- Name: project_frontend_rollouts project_frontend_rollouts_updated_by_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_frontend_rollouts
    ADD CONSTRAINT project_frontend_rollouts_updated_by_workspace_id_fkey FOREIGN KEY (updated_by, workspace_id) REFERENCES public.admin_users(id, workspace_id) ON DELETE RESTRICT;


--
-- Name: project_members project_members_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.admin_users(id) ON DELETE CASCADE;


--
-- Name: projects projects_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: release_artifacts release_artifacts_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_artifacts
    ADD CONSTRAINT release_artifacts_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.knowledge_artifacts(id) ON DELETE RESTRICT;


--
-- Name: release_artifacts release_artifacts_release_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_artifacts
    ADD CONSTRAINT release_artifacts_release_id_fkey FOREIGN KEY (release_id) REFERENCES public.releases(id) ON DELETE CASCADE;


--
-- Name: release_channels release_channels_release_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_channels
    ADD CONSTRAINT release_channels_release_id_workspace_id_fkey FOREIGN KEY (release_id, workspace_id) REFERENCES public.releases(id, workspace_id);


--
-- Name: release_channels release_channels_repository_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_channels
    ADD CONSTRAINT release_channels_repository_id_workspace_id_fkey FOREIGN KEY (repository_id, workspace_id) REFERENCES public.repositories(id, workspace_id) ON DELETE CASCADE;


--
-- Name: release_channels release_channels_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_channels
    ADD CONSTRAINT release_channels_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: releases releases_build_job_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_build_job_id_workspace_id_fkey FOREIGN KEY (build_job_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id) ON DELETE RESTRICT;


--
-- Name: releases releases_package_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_package_artifact_id_fkey FOREIGN KEY (package_artifact_id) REFERENCES public.knowledge_artifacts(id) ON DELETE RESTRICT;


--
-- Name: releases releases_package_stage_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_package_stage_run_id_fkey FOREIGN KEY (package_stage_run_id) REFERENCES public.build_stage_runs(id) ON DELETE RESTRICT;


--
-- Name: releases releases_repository_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_repository_id_workspace_id_fkey FOREIGN KEY (repository_id, workspace_id) REFERENCES public.repositories(id, workspace_id) ON DELETE CASCADE;


--
-- Name: releases releases_snapshot_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_snapshot_workspace_fk FOREIGN KEY (snapshot_id, workspace_id) REFERENCES public.source_snapshots(id, workspace_id) ON DELETE RESTRICT;


--
-- Name: releases releases_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: remediation_cases remediation_cases_project_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_cases
    ADD CONSTRAINT remediation_cases_project_id_workspace_id_fkey FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE;


--
-- Name: remediation_cases remediation_cases_rebuild_build_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_cases
    ADD CONSTRAINT remediation_cases_rebuild_build_id_workspace_id_fkey FOREIGN KEY (rebuild_build_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id) ON DELETE RESTRICT;


--
-- Name: remediation_cases remediation_cases_repository_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_cases
    ADD CONSTRAINT remediation_cases_repository_id_workspace_id_fkey FOREIGN KEY (repository_id, workspace_id) REFERENCES public.repositories(id, workspace_id) ON DELETE CASCADE;


--
-- Name: remediation_cases remediation_cases_source_build_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_cases
    ADD CONSTRAINT remediation_cases_source_build_id_workspace_id_fkey FOREIGN KEY (source_build_id, workspace_id) REFERENCES public.build_jobs(id, workspace_id) ON DELETE RESTRICT;


--
-- Name: remediation_cases remediation_cases_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_cases
    ADD CONSTRAINT remediation_cases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: remediation_events remediation_events_actor_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_events
    ADD CONSTRAINT remediation_events_actor_id_workspace_id_fkey FOREIGN KEY (actor_id, workspace_id) REFERENCES public.admin_users(id, workspace_id) ON DELETE RESTRICT;


--
-- Name: remediation_events remediation_events_remediation_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_events
    ADD CONSTRAINT remediation_events_remediation_id_workspace_id_fkey FOREIGN KEY (remediation_id, workspace_id) REFERENCES public.remediation_cases(id, workspace_id) ON DELETE CASCADE;


--
-- Name: remediation_events remediation_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remediation_events
    ADD CONSTRAINT remediation_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: repositories repositories_project_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_project_workspace_fk FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE;


--
-- Name: repositories repositories_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: repository_sync_schedules repository_sync_schedules_repository_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_sync_schedules
    ADD CONSTRAINT repository_sync_schedules_repository_id_workspace_id_fkey FOREIGN KEY (repository_id, workspace_id) REFERENCES public.repositories(id, workspace_id) ON DELETE CASCADE;


--
-- Name: repository_sync_schedules repository_sync_schedules_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_sync_schedules
    ADD CONSTRAINT repository_sync_schedules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: source_analysis_artifacts source_analysis_artifacts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_analysis_artifacts
    ADD CONSTRAINT source_analysis_artifacts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: source_blobs source_blobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_blobs
    ADD CONSTRAINT source_blobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: source_files source_files_snapshot_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_files
    ADD CONSTRAINT source_files_snapshot_id_workspace_id_fkey FOREIGN KEY (snapshot_id, workspace_id) REFERENCES public.source_snapshots(id, workspace_id) ON DELETE CASCADE;


--
-- Name: source_files source_files_source_blob_identity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_files
    ADD CONSTRAINT source_files_source_blob_identity_fk FOREIGN KEY (source_blob_id, workspace_id, content_hash, byte_size) REFERENCES public.source_blobs(id, workspace_id, content_hash, byte_size) ON DELETE RESTRICT;


--
-- Name: source_files source_files_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_files
    ADD CONSTRAINT source_files_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: source_snapshots source_snapshots_pending_import_report_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_pending_import_report_scope_fk FOREIGN KEY (pending_import_report_id, workspace_id, repository_id) REFERENCES public.import_reports(id, workspace_id, repository_id) ON DELETE CASCADE;


--
-- Name: source_snapshots source_snapshots_pending_upload_session_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_pending_upload_session_workspace_fk FOREIGN KEY (pending_upload_session_id, workspace_id) REFERENCES public.upload_sessions(id, workspace_id) ON DELETE CASCADE;


--
-- Name: source_snapshots source_snapshots_repository_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_repository_id_workspace_id_fkey FOREIGN KEY (repository_id, workspace_id) REFERENCES public.repositories(id, workspace_id) ON DELETE CASCADE;


--
-- Name: source_snapshots source_snapshots_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_snapshots
    ADD CONSTRAINT source_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: upload_idempotency_keys upload_idempotency_keys_actor_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_idempotency_keys
    ADD CONSTRAINT upload_idempotency_keys_actor_workspace_fk FOREIGN KEY (actor_id, workspace_id) REFERENCES public.admin_users(id, workspace_id) ON DELETE CASCADE;


--
-- Name: upload_idempotency_keys upload_idempotency_keys_session_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_idempotency_keys
    ADD CONSTRAINT upload_idempotency_keys_session_workspace_fk FOREIGN KEY (session_id, workspace_id) REFERENCES public.upload_sessions(id, workspace_id) ON DELETE CASCADE;


--
-- Name: upload_idempotency_keys upload_idempotency_keys_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_idempotency_keys
    ADD CONSTRAINT upload_idempotency_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: upload_session_entries upload_session_entries_session_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_session_entries
    ADD CONSTRAINT upload_session_entries_session_workspace_fk FOREIGN KEY (session_id, workspace_id) REFERENCES public.upload_sessions(id, workspace_id) ON DELETE CASCADE;


--
-- Name: upload_sessions upload_sessions_actor_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_actor_workspace_fk FOREIGN KEY (actor_id, workspace_id) REFERENCES public.admin_users(id, workspace_id) ON DELETE CASCADE;


--
-- Name: upload_sessions upload_sessions_expected_current_repository_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_expected_current_repository_scope_fk FOREIGN KEY (expected_current_repository_id, workspace_id, project_id) REFERENCES public.repositories(id, workspace_id, project_id) ON DELETE CASCADE;


--
-- Name: upload_sessions upload_sessions_expected_latest_snapshot_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_expected_latest_snapshot_scope_fk FOREIGN KEY (expected_latest_snapshot_id, workspace_id, repository_id) REFERENCES public.source_snapshots(id, workspace_id, repository_id) ON DELETE RESTRICT;


--
-- Name: upload_sessions upload_sessions_project_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_project_workspace_fk FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE CASCADE;


--
-- Name: upload_sessions upload_sessions_repository_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_repository_scope_fk FOREIGN KEY (repository_id, workspace_id, project_id) REFERENCES public.repositories(id, workspace_id, project_id) ON DELETE CASCADE;


--
-- Name: upload_sessions upload_sessions_snapshot_repository_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_snapshot_repository_fk FOREIGN KEY (snapshot_id, workspace_id, repository_id) REFERENCES public.source_snapshots(id, workspace_id, repository_id) ON DELETE RESTRICT;


--
-- Name: upload_sessions upload_sessions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_user_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_workspace_id_fkey FOREIGN KEY (user_id, workspace_id) REFERENCES public.admin_users(id, workspace_id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict YdJC0XB8UtWWxcYnyvhflxQnoIskgtuOnUtPBs0G5fytcxS97bNFGURhyZyat3a

--
-- PostgreSQL database dump
--

\restrict ogDEldSlDTloxPO4MVJMokkLcRPC2hrTmOZT55tmtTdkjy41Zczo84ndd45hGLA

-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0001_initial.sql', '2026-07-21 11:15:03.823966+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0002_secure_repository_snapshots.sql', '2026-07-21 11:15:03.869334+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0003_cited_knowledge_releases.sql', '2026-07-21 11:15:03.873431+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0004_harden_knowledge_invariants.sql', '2026-07-21 11:15:03.884401+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0005_mcp_feedback.sql', '2026-07-21 11:15:03.888238+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0006_console_review_fixes.sql', '2026-07-21 11:15:03.890653+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0007_final_production_review.sql', '2026-07-21 11:15:03.892588+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0008_bounded_knowledge_queries.sql', '2026-07-21 11:15:03.894671+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0009_repository_archives.sql', '2026-07-21 11:15:03.89655+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0010_chinese_knowledge_search.sql', '2026-07-21 11:15:03.898162+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0011_team_projects_and_roles.sql', '2026-07-21 11:15:03.899294+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0012_project_members.sql', '2026-07-21 11:15:03.906918+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0013_import_reports.sql', '2026-07-21 11:15:03.909561+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0014_member_session_security.sql', '2026-07-21 11:15:03.913121+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0015_auth_sessions.sql', '2026-07-21 11:15:03.914597+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0016_admin_mfa.sql', '2026-07-21 11:15:03.916958+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0017_mcp_token_expiry.sql', '2026-07-21 11:15:03.921742+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0018_knowledge_pipeline.sql', '2026-07-21 11:15:03.923379+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0019_pipeline_events.sql', '2026-07-21 11:15:03.930945+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0020_knowledge_graph.sql', '2026-07-21 11:15:03.934514+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0021_remediation_cases.sql', '2026-07-21 11:15:03.940606+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0022_remediation_issue_identity.sql', '2026-07-21 11:15:03.947083+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0023_pipeline_search_documents.sql', '2026-07-21 11:15:03.94888+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0024_release_pipeline_provenance.sql', '2026-07-21 11:15:03.952652+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0025_stage_run_retry_schedule.sql', '2026-07-21 11:15:03.953812+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0026_manual_llm_builds.sql', '2026-07-21 11:15:03.95543+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0027_pipeline_search_reuse.sql', '2026-07-21 11:15:03.956365+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0028_release_provenance_immutable.sql', '2026-07-21 11:15:03.957971+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0029_remediation_dismissal_reason.sql', '2026-07-21 11:15:03.958937+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0030_repository_sync_schedules.sql', '2026-07-21 11:15:03.959961+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0031_frontend_contracts_rollout.sql', '2026-07-21 11:15:03.962699+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0032_source_analysis_artifacts.sql', '2026-07-21 11:15:03.968138+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0033_upload_sessions.sql', '2026-07-21 11:15:03.970568+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0034_source_blobs.sql', '2026-07-21 11:15:03.983848+00');
INSERT INTO public.schema_migrations (name, applied_at) VALUES ('0035_source_blobs_contract.sql', '2026-07-21 11:15:03.991963+00');


--
-- PostgreSQL database dump complete
--

\unrestrict ogDEldSlDTloxPO4MVJMokkLcRPC2hrTmOZT55tmtTdkjy41Zczo84ndd45hGLA
