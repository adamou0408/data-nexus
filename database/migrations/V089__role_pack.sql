-- ============================================================
-- V089: Role Pack template (Permission Slimming · 路 2)
--
-- ── Problem ──
--   31 (now 26 after V088) authz_role_permission rows encode 6-7 real
--   business patterns. Every new admin role / new admin surface still
--   requires hand-typing the same N rows. Role assignment is fine
--   (LDAP-driven), but role *permission editing* doesn't scale: you've
--   already paid the design cost in V003 ABAC schema (0 active policies)
--   so we don't need a new execution model — we need a better editing
--   surface.
--
-- ── Choice ──
--   Add a "pack" abstraction that GROUPS (resource_id, action_id) tuples
--   and is APPLIED to one or more roles. When you apply pack P to role R,
--   the service expands the pack into authz_role_permission rows tagged
--   pack_source=P. Edit the pack → all assigned roles re-sync. Unapply →
--   the tagged rows go away.
--
--   Execution model is unchanged: authz_check / authz_resolve still read
--   authz_role_permission row-by-row. Pack is metadata, not a runtime
--   policy primitive — that distinction matters: explainability stays at
--   one hop, blast radius is bounded by "rows tagged with this pack".
--
-- ── Tables ──
--   authz_role_pack             — definition (id, display_name, is_system)
--   authz_role_pack_member      — (pack_id, resource_id, action_id, effect)
--   authz_role_pack_assignment  — (pack_id, role_id) join: which roles
--                                 currently have this pack applied
--
-- ── Tag column ──
--   authz_role_permission gets a new pack_source column. NULL = manual
--   grant (NEVER touched by re-sync). NOT NULL = managed by that pack.
--   This lets manual rows coexist with pack-expanded rows on the same
--   role without one stomping the other.
--
-- ── Out of scope ──
--   Trigger-based auto-sync (rejected: PG triggers can't capture the
--   current API user reliably for admin audit). Sync is performed by
--   services/authz-api/src/lib/role-pack.ts inside an explicit transaction.
--
--   Per-resource wildcard members (e.g. "all published_dag with
--   status=active"). That's path 3 (real ABAC). Pack members are concrete
--   (resource_id, action_id) tuples for now.
-- ============================================================

BEGIN;

-- ─── 1. Pack definition ─────────────────────────────────────
CREATE TABLE authz_role_pack (
  pack_id       text        PRIMARY KEY,
  display_name  text        NOT NULL,
  description   text,
  -- System packs (seeded by migration) cannot be deleted via API.
  -- Updates to display_name/description are still allowed.
  is_system     boolean     NOT NULL DEFAULT false,
  created_by    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_pack_id_format CHECK (pack_id ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT role_pack_name_nonblank CHECK (length(btrim(display_name)) > 0)
);

COMMENT ON TABLE authz_role_pack IS
  'Permission slimming 路 2: groups of (resource, action) granted as a unit. Editing surface, not a runtime primitive — execution still goes through authz_role_permission.';
COMMENT ON COLUMN authz_role_pack.is_system IS
  'Seeded packs (admin_pack, steward_pack, etc). API DELETE is refused; member edits are still allowed.';

-- updated_at touch trigger (reuse the standard pattern).
CREATE OR REPLACE FUNCTION fn_role_pack_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_role_pack_touch
  BEFORE UPDATE ON authz_role_pack
  FOR EACH ROW EXECUTE FUNCTION fn_role_pack_touch();

-- ─── 2. Pack members: (resource, action) tuples in the pack ─
CREATE TABLE authz_role_pack_member (
  pack_id      text         NOT NULL REFERENCES authz_role_pack(pack_id) ON DELETE CASCADE,
  resource_id  text         NOT NULL REFERENCES authz_resource(resource_id) ON DELETE CASCADE,
  action_id    text         NOT NULL REFERENCES authz_action(action_id)    ON DELETE CASCADE,
  effect       authz_effect NOT NULL DEFAULT 'allow',
  added_by     text         NOT NULL,
  added_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, resource_id, action_id)
);

COMMENT ON TABLE authz_role_pack_member IS
  'Concrete (resource_id, action_id) tuples in a pack. Wildcards / ABAC conditions are path 3, not here.';

-- ─── 3. Pack assignments: which roles currently have this pack ──
CREATE TABLE authz_role_pack_assignment (
  pack_id     text        NOT NULL REFERENCES authz_role_pack(pack_id) ON DELETE CASCADE,
  role_id     text        NOT NULL REFERENCES authz_role(role_id)      ON DELETE CASCADE,
  applied_by  text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, role_id)
);

CREATE INDEX role_pack_assignment_role_idx
  ON authz_role_pack_assignment (role_id);

COMMENT ON TABLE authz_role_pack_assignment IS
  'Join table — pack P is currently applied to role R. Maintained by /api/role-pack/:p/assignments/:r endpoints.';

-- ─── 4. Tag rows in authz_role_permission with their pack source ──
-- NULL = manually granted (untouched by pack sync, this is the safe default).
-- NOT NULL = expanded from this pack.
ALTER TABLE authz_role_permission
  ADD COLUMN pack_source text REFERENCES authz_role_pack(pack_id) ON DELETE SET NULL;

CREATE INDEX role_permission_pack_source_idx
  ON authz_role_permission (pack_source)
  WHERE pack_source IS NOT NULL;

COMMENT ON COLUMN authz_role_permission.pack_source IS
  'NULL = manual grant. NOT NULL = expanded from authz_role_pack.pack_id; re-sync will recompute these.';

-- ─── 5. Sanity: a pack-row-source must agree with an actual assignment ─
-- We can't enforce this at INSERT time as a CHECK (it would need a
-- subquery), but we can install a trigger that refuses pack-tagged rows
-- when no matching assignment exists. This catches accidental writes
-- bypassing the service layer.
CREATE OR REPLACE FUNCTION fn_role_perm_pack_source_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.pack_source IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM authz_role_pack_assignment
       WHERE pack_id = NEW.pack_source AND role_id = NEW.role_id
    ) THEN
      RAISE EXCEPTION
        'pack_source=% on role_id=% but no matching authz_role_pack_assignment row',
        NEW.pack_source, NEW.role_id;
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_role_perm_pack_source_guard
  BEFORE INSERT OR UPDATE OF pack_source ON authz_role_permission
  FOR EACH ROW EXECUTE FUNCTION fn_role_perm_pack_source_guard();

COMMIT;
