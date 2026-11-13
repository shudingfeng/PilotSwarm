/** Each user's opt-in to the deployment's dispatcher creating and ending sessions for them. */
export function dispatcherDelegationMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
-- A column of its own: the portal replaces profile_settings wholesale on every
-- preference save, so an opt-in kept there would be lost by an unrelated save.
ALTER TABLE ${s}.users ADD COLUMN IF NOT EXISTS allow_dispatcher_delegation BOOLEAN NOT NULL DEFAULT false;

-- Registers the user on first use, like the profile and role writers, then
-- replaces the flag. Returns the stored value.
CREATE OR REPLACE FUNCTION ${s}.cms_set_user_dispatcher_delegation(
    p_provider     TEXT,
    p_subject      TEXT,
    p_email        TEXT,
    p_display_name TEXT,
    p_enabled      BOOLEAN
) RETURNS BOOLEAN AS $$
DECLARE
    v_user_id BIGINT;
BEGIN
    IF p_enabled IS NULL THEN
        RAISE EXCEPTION 'Dispatcher delegation must be true or false';
    END IF;
    v_user_id := ${s}.cms_register_user(p_provider, p_subject, p_email, p_display_name);
    UPDATE ${s}.users
    SET allow_dispatcher_delegation = p_enabled,
        updated_at = now()
    WHERE user_id = v_user_id;
    RETURN p_enabled;
END;
$$ LANGUAGE plpgsql;

-- False for an unknown user: nobody is opted in until they say so.
CREATE OR REPLACE FUNCTION ${s}.cms_get_user_dispatcher_delegation(
    p_provider TEXT,
    p_subject  TEXT
) RETURNS BOOLEAN AS $$
    SELECT COALESCE((
        SELECT u.allow_dispatcher_delegation
        FROM ${s}.users u
        WHERE u.provider = NULLIF(BTRIM(p_provider), '')
          AND u.subject = NULLIF(BTRIM(p_subject), '')
    ), false);
$$ LANGUAGE sql STABLE;
`;
}
