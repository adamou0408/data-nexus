-- ============================================================
-- V016: Column Mask Functions (actual PG implementations)
-- Referenced by authz_mask_function registry (V003)
-- ============================================================

-- Full mask: replace with ****
CREATE OR REPLACE FUNCTION fn_mask_full(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT '****'::TEXT;
$$;

-- Partial mask: show first and last chars
CREATE OR REPLACE FUNCTION fn_mask_partial(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN length(p_value) <= 2 THEN '****'
        ELSE left(p_value, 1) || repeat('*', greatest(length(p_value) - 2, 3)) || right(p_value, 1)
    END;
$$;

-- Hash mask: SHA256 truncated
CREATE OR REPLACE FUNCTION fn_mask_hash(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT left(encode(sha256(p_value::bytea), 'hex'), 12) || '...';
$$;

-- Range mask: numeric value to bucket range
CREATE OR REPLACE FUNCTION fn_mask_range(p_value NUMERIC)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_value IS NULL THEN '****'
        WHEN p_value < 10 THEN '0-10'
        WHEN p_value < 50 THEN '10-50'
        WHEN p_value < 100 THEN '50-100'
        WHEN p_value < 500 THEN '100-500'
        WHEN p_value < 1000 THEN '500-1K'
        WHEN p_value < 10000 THEN '1K-10K'
        ELSE '10K+'
    END;
$$;

-- Overloads for fn_mask_full on numeric (cast to text)
CREATE OR REPLACE FUNCTION fn_mask_full(p_value NUMERIC)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT '****'::TEXT;
$$;
