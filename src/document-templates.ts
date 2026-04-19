// Document template library for the Documents feature.
// Templates are authored here (not in SQL) because they evolve with product
// needs — versioning them via git is cleaner than diffing SQL seed rows.
// Workspace-specific templates (future) live in the document_templates table.
//
// Variable syntax: [[key]] placeholders in defaultContent. Template authors
// declare each [[key]] in the `variables` array with its type + label +
// required flag. The renderer substitutes per-key at render time.
//
// Ported from OpenClaw Mission Control (lib/templates.ts) with categories
// mapped to ClaudeClaw's palette.

export type DocumentType =
  | 'proposal'
  | 'scope_of_work'
  | 'nda'
  | 'creator_agreement'
  | 'invoice'
  | 'project_brief'
  | 'meeting_agenda'
  | 'campaign_brief'
  | 'weekly_summary'
  | 'general';

export type DocumentCategory =
  | 'Client-Facing'
  | 'Legal'
  | 'Finance'
  | 'Operations'
  | 'Marketing'
  | 'Reports';

export type TemplateVariableType = 'text' | 'date' | 'number' | 'textarea' | 'select';

export interface TemplateVariable {
  key: string;
  label: string;
  type: TemplateVariableType;
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export interface DocumentTemplate {
  id: string;
  label: string;
  type: DocumentType;
  category: DocumentCategory;
  description: string;
  variables: TemplateVariable[];
  defaultContent: string;
}

const PROPOSAL: DocumentTemplate = {
  id: 'proposal_basic',
  label: 'Client Proposal',
  type: 'proposal',
  category: 'Client-Facing',
  description: 'Cover letter, objectives, scope, deliverables, pricing.',
  variables: [
    { key: 'client_name', label: 'Client name', type: 'text', required: true, placeholder: 'Jane Smith' },
    { key: 'project_title', label: 'Project title', type: 'text', required: true, placeholder: 'Luxury Relocation Package' },
    { key: 'your_name', label: 'Your name', type: 'text', required: true, placeholder: 'Jane Doe' },
    { key: 'company_name', label: 'Your company', type: 'text', required: true, placeholder: 'Workspace A' },
    { key: 'date', label: 'Proposal date', type: 'date', required: true },
    { key: 'objectives', label: 'Objectives', type: 'textarea', required: true, placeholder: 'What the client wants to achieve' },
    { key: 'scope', label: 'Scope summary', type: 'textarea', required: true, placeholder: 'High-level scope of work' },
    { key: 'price', label: 'Price (USD)', type: 'number', required: true, placeholder: '25000' },
    { key: 'timeline', label: 'Timeline', type: 'text', required: false, placeholder: '3 months' },
  ],
  defaultContent: `# Proposal: [[project_title]]

**Prepared for:** [[client_name]]
**Prepared by:** [[your_name]], [[company_name]]
**Date:** [[date]]

---

## Objectives

[[objectives]]

## Scope

[[scope]]

## Timeline

[[timeline]]

## Investment

**Total:** $[[price]] USD

---

*Thank you for the opportunity to work together.*
`,
};

const SCOPE_OF_WORK: DocumentTemplate = {
  id: 'scope_of_work_basic',
  label: 'Scope of Work',
  type: 'scope_of_work',
  category: 'Legal',
  description: 'Detailed SOW with deliverables, milestones, and acceptance criteria.',
  variables: [
    { key: 'client_name', label: 'Client', type: 'text', required: true },
    { key: 'provider_name', label: 'Provider', type: 'text', required: true },
    { key: 'project_title', label: 'Project', type: 'text', required: true },
    { key: 'start_date', label: 'Start date', type: 'date', required: true },
    { key: 'end_date', label: 'End date', type: 'date', required: true },
    { key: 'deliverables', label: 'Deliverables (one per line)', type: 'textarea', required: true },
    { key: 'acceptance_criteria', label: 'Acceptance criteria', type: 'textarea', required: true },
    { key: 'fee', label: 'Fee (USD)', type: 'number', required: true },
    { key: 'payment_terms', label: 'Payment terms', type: 'text', required: true, placeholder: '50% upfront, 50% on delivery' },
  ],
  defaultContent: `# Scope of Work

**Project:** [[project_title]]
**Client:** [[client_name]]
**Provider:** [[provider_name]]
**Term:** [[start_date]] – [[end_date]]

## Deliverables

[[deliverables]]

## Acceptance Criteria

[[acceptance_criteria]]

## Fee

$[[fee]] USD · [[payment_terms]]

## Signatures

_Client_: __________________  _Date_: __________

_Provider_: _______________  _Date_: __________
`,
};

const NDA: DocumentTemplate = {
  id: 'nda_mutual',
  label: 'Mutual NDA',
  type: 'nda',
  category: 'Legal',
  description: 'Two-party mutual non-disclosure agreement with standard terms.',
  variables: [
    { key: 'party_a', label: 'Party A', type: 'text', required: true },
    { key: 'party_b', label: 'Party B', type: 'text', required: true },
    { key: 'effective_date', label: 'Effective date', type: 'date', required: true },
    { key: 'term_years', label: 'Term (years)', type: 'number', required: true, placeholder: '3' },
    { key: 'governing_law', label: 'Governing law', type: 'text', required: true, placeholder: 'Costa Rica' },
  ],
  defaultContent: `# Mutual Non-Disclosure Agreement

**Between:** [[party_a]] and [[party_b]]
**Effective Date:** [[effective_date]]

## 1. Purpose

The parties wish to explore a potential business relationship and will need to disclose confidential information to each other.

## 2. Confidential Information

Any non-public information, technical data, trade secrets, know-how, research, product plans, or financials disclosed by one party to the other.

## 3. Obligations

Each party agrees to:
- Hold Confidential Information in strict confidence
- Not disclose it to any third party without prior written consent
- Use it only for the stated purpose

## 4. Term

This agreement remains in effect for [[term_years]] years from the Effective Date.

## 5. Governing Law

This agreement is governed by the laws of [[governing_law]].

## Signatures

[[party_a]]: ________________________  Date: __________

[[party_b]]: ________________________  Date: __________
`,
};

const CREATOR_AGREEMENT: DocumentTemplate = {
  id: 'creator_agreement_basic',
  label: 'Creator Agreement',
  type: 'creator_agreement',
  category: 'Legal',
  description: 'Creator engagement terms (rates, deliverables, usage rights).',
  variables: [
    { key: 'creator_name', label: 'Creator', type: 'text', required: true },
    { key: 'company_name', label: 'Company', type: 'text', required: true },
    { key: 'start_date', label: 'Start date', type: 'date', required: true },
    { key: 'monthly_rate', label: 'Monthly rate (USD)', type: 'number', required: true },
    { key: 'deliverables_per_month', label: 'Deliverables per month', type: 'text', required: true, placeholder: '4 short-form videos + 1 long-form' },
    { key: 'usage_rights', label: 'Usage rights', type: 'select', required: true,
      options: ['Perpetual, worldwide, all media', 'Organic only, 12 months', 'Paid media, 6 months'] },
  ],
  defaultContent: `# Creator Agreement

**Creator:** [[creator_name]]
**Company:** [[company_name]]
**Start Date:** [[start_date]]

## Engagement

Creator will produce and deliver:

[[deliverables_per_month]]

## Compensation

Monthly retainer: $[[monthly_rate]] USD, payable net-30 from invoice.

## Usage Rights

[[usage_rights]].

## Termination

Either party may terminate with 30 days' written notice.

## Signatures

[[creator_name]]: ______________________  Date: __________

[[company_name]]: ______________________  Date: __________
`,
};

const INVOICE: DocumentTemplate = {
  id: 'invoice_basic',
  label: 'Invoice',
  type: 'invoice',
  category: 'Finance',
  description: 'Standard service invoice with line items and totals.',
  variables: [
    { key: 'invoice_number', label: 'Invoice #', type: 'text', required: true, placeholder: 'INV-2026-001' },
    { key: 'invoice_date', label: 'Date', type: 'date', required: true },
    { key: 'due_date', label: 'Due date', type: 'date', required: true },
    { key: 'bill_to', label: 'Bill to', type: 'textarea', required: true, placeholder: 'Client name + address' },
    { key: 'from', label: 'From', type: 'textarea', required: true, placeholder: 'Your name + address' },
    { key: 'line_items', label: 'Line items (Description | Qty | Unit | Amount per line)', type: 'textarea', required: true },
    { key: 'subtotal', label: 'Subtotal (USD)', type: 'number', required: true },
    { key: 'tax', label: 'Tax (USD)', type: 'number', required: false, placeholder: '0' },
    { key: 'total', label: 'Total (USD)', type: 'number', required: true },
    { key: 'payment_instructions', label: 'Payment instructions', type: 'textarea', required: true },
  ],
  defaultContent: `# Invoice [[invoice_number]]

**Date:** [[invoice_date]]
**Due:** [[due_date]]

## From

[[from]]

## Bill To

[[bill_to]]

## Line Items

[[line_items]]

---

**Subtotal:** $[[subtotal]]
**Tax:** $[[tax]]
**Total Due:** $[[total]] USD

## Payment

[[payment_instructions]]
`,
};

const PROJECT_BRIEF: DocumentTemplate = {
  id: 'project_brief_basic',
  label: 'Project Brief',
  type: 'project_brief',
  category: 'Operations',
  description: 'One-pager that defines goal, scope, success metrics, and team.',
  variables: [
    { key: 'project_title', label: 'Project title', type: 'text', required: true },
    { key: 'owner', label: 'Owner', type: 'text', required: true },
    { key: 'goal', label: 'Goal', type: 'textarea', required: true },
    { key: 'success_metrics', label: 'Success metrics', type: 'textarea', required: true },
    { key: 'non_goals', label: 'Explicitly out of scope', type: 'textarea', required: false },
    { key: 'team', label: 'Team + roles', type: 'textarea', required: true },
    { key: 'timeline', label: 'Timeline', type: 'text', required: true },
  ],
  defaultContent: `# [[project_title]]

**Owner:** [[owner]]
**Timeline:** [[timeline]]

## Goal

[[goal]]

## Success Metrics

[[success_metrics]]

## Non-Goals

[[non_goals]]

## Team

[[team]]
`,
};

const MEETING_AGENDA: DocumentTemplate = {
  id: 'meeting_agenda_basic',
  label: 'Meeting Agenda',
  type: 'meeting_agenda',
  category: 'Operations',
  description: 'Pre-meeting agenda with topics, time-boxes, and owners.',
  variables: [
    { key: 'meeting_title', label: 'Meeting title', type: 'text', required: true },
    { key: 'date_time', label: 'Date + time', type: 'text', required: true, placeholder: '2026-04-25, 10:00 CR' },
    { key: 'attendees', label: 'Attendees', type: 'textarea', required: true },
    { key: 'topics', label: 'Topics (one per line: Topic | Owner | Minutes)', type: 'textarea', required: true },
    { key: 'pre_read', label: 'Pre-read links', type: 'textarea', required: false },
  ],
  defaultContent: `# [[meeting_title]]

**When:** [[date_time]]
**Attendees:** [[attendees]]

## Pre-read

[[pre_read]]

## Agenda

[[topics]]

## Action Items (filled during meeting)

- [ ]
- [ ]
- [ ]
`,
};

const CAMPAIGN_BRIEF: DocumentTemplate = {
  id: 'campaign_brief_basic',
  label: 'Campaign Brief',
  type: 'campaign_brief',
  category: 'Marketing',
  description: 'Marketing campaign one-pager: audience, message, channels, KPIs.',
  variables: [
    { key: 'campaign_name', label: 'Campaign name', type: 'text', required: true },
    { key: 'launch_date', label: 'Launch date', type: 'date', required: true },
    { key: 'audience', label: 'Target audience', type: 'textarea', required: true },
    { key: 'objective', label: 'Objective', type: 'textarea', required: true },
    { key: 'message', label: 'Key message', type: 'textarea', required: true },
    { key: 'channels', label: 'Channels', type: 'textarea', required: true, placeholder: 'One channel per line' },
    { key: 'kpis', label: 'Primary KPIs', type: 'textarea', required: true },
    { key: 'budget', label: 'Budget (USD)', type: 'number', required: false },
  ],
  defaultContent: `# Campaign: [[campaign_name]]

**Launch:** [[launch_date]]
**Budget:** $[[budget]] USD

## Audience

[[audience]]

## Objective

[[objective]]

## Key Message

[[message]]

## Channels

[[channels]]

## KPIs

[[kpis]]
`,
};

const WEEKLY_SUMMARY: DocumentTemplate = {
  id: 'weekly_summary_basic',
  label: 'Weekly Summary',
  type: 'weekly_summary',
  category: 'Reports',
  description: 'End-of-week status: wins, misses, blockers, next week.',
  variables: [
    { key: 'week_ending', label: 'Week ending', type: 'date', required: true },
    { key: 'wins', label: 'Wins', type: 'textarea', required: true },
    { key: 'misses', label: 'Misses / off-track', type: 'textarea', required: false },
    { key: 'blockers', label: 'Blockers', type: 'textarea', required: false },
    { key: 'next_week', label: 'Focus for next week', type: 'textarea', required: true },
    { key: 'metrics', label: 'Metrics snapshot', type: 'textarea', required: false },
  ],
  defaultContent: `# Weekly Summary — Week Ending [[week_ending]]

## Wins

[[wins]]

## Misses

[[misses]]

## Blockers

[[blockers]]

## Metrics

[[metrics]]

## Focus for Next Week

[[next_week]]
`,
};

export const BUILT_IN_TEMPLATES: DocumentTemplate[] = [
  PROPOSAL,
  SCOPE_OF_WORK,
  NDA,
  CREATOR_AGREEMENT,
  INVOICE,
  PROJECT_BRIEF,
  MEETING_AGENDA,
  CAMPAIGN_BRIEF,
  WEEKLY_SUMMARY,
];

/** Render template defaultContent by substituting [[key]] placeholders. */
export function renderTemplate(
  template: DocumentTemplate,
  variables: Record<string, string>,
): string {
  return template.defaultContent.replace(/\[\[\s*([a-zA-Z0-9_]+)\s*\]\]/g, (_match, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return variables[key] ?? '';
    }
    // Preserve placeholder if not provided — helps author see what's missing.
    return `[[${key}]]`;
  });
}

/** Find a built-in template by id. O(n) over a tiny list; fine. */
export function findTemplate(id: string): DocumentTemplate | null {
  return BUILT_IN_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** List distinct categories preserving the ordered enum. */
export function listCategories(): DocumentCategory[] {
  const seen = new Set<DocumentCategory>();
  const ordered: DocumentCategory[] = [];
  for (const t of BUILT_IN_TEMPLATES) {
    if (!seen.has(t.category)) {
      seen.add(t.category);
      ordered.push(t.category);
    }
  }
  return ordered;
}
