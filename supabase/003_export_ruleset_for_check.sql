-- Run in the Supabase SQL editor AFTER promoting rules to active.
-- Returns ONE cell of JSON. Copy it into a file (e.g. db_export.json) and run:
--   node compare_rulesets.js --bundled ../../src/lib/layer2_ruleset.js \
--        --rules db_export.json --corpus corpus/seed_corpus.json --corpus corpus/stress_corpus.json
-- This proves the rows as stored in the database behave identically to the app's
-- bundled rules — not just the file that was generated.
select json_build_object(
  'rules', coalesce((
    select json_agg(json_build_object(
      'layer', layer, 'rule_key', rule_key, 'priority', priority,
      'match_patterns', match_patterns, 'exclude_patterns', exclude_patterns,
      'fixed_fields', fixed_fields, 'field_overrides', field_overrides
    ) order by priority)
    from public.parse_rules
    where layer = 2 and status = 'active'
  ), '[]'::json),
  'aliases', (
    select json_agg(json_build_object('token', token, 'bank_name', bank_name, 'priority', priority) order by priority)
    from public.bank_aliases
  )
) as ruleset;