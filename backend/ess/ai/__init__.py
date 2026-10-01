"""AI engine layer with strict quality gates.

* ``engine``        – AIEngine: provider-neutral, schema-validated JSON; policy checked on every call
* ``registry``      – curated model catalogue (registry.yaml) + rules for unknown model IDs
* ``policy``        – eligibility policy with a hard floor enforced in code (no bypass flag)
* ``qualification`` – the exam every model must pass on this workspace (cases in ``exam_cases``)
* ``guards``        – evidence verification, price stripping, schema validation
* ``tasks``         – prompts + schemas + post-guards for every AI task
* ``rules``         – deterministic keyword classifier (works without any AI)
* ``providers``     – live model listing per provider
* ``external``      – the same gate for an AI client connected over MCP
* ``store``         – local persistence of the policy and exam results

Submodules are imported on demand; importing ``ess.ai`` never loads a provider SDK.
"""

__all__ = ["engine", "registry", "policy", "qualification", "exam_cases", "guards", "tasks", "rules",
           "providers", "external", "store", "errors"]
