/**
 * Fixture data for the mock orchestrator: the pipeline, the settings and the
 * job postings, expanded into full `Lead` objects shaped like docs/api.md.
 */
import { createHash } from 'node:crypto';
import { AGENTS, LEAD_SEEDS, RUN_SEEDS, SOURCES } from './seeds.mjs';

export const pipeline = {
  nodes: [
    ...SOURCES.map(([name, label, enabled]) => ({
      id: `source:${name}`,
      label,
      kind: 'source',
      description: `Job board adapter for ${label}.`,
      model: '',
      parent: 'scout',
      enabled,
    })),
    ...AGENTS.map(([id, label, kind, model, description]) => ({
      id,
      label,
      kind,
      description,
      model,
      enabled: true,
    })),
  ],
  edges: [
    ...SOURCES.map(([name]) => ({ source: `source:${name}`, target: 'scout' })),
    ...AGENTS.slice(1).map(([id], index) => ({ source: AGENTS[index][0], target: id })),
  ],
};

export const settings = {
  sources: Object.fromEntries(SOURCES.map(([name, , enabled]) => [name, enabled])),
  keywords: ['AI Engineer', 'ML Engineer', 'Machine Learning', 'Data Scientist', 'LLM', 'GenAI'],
  exclude_keywords: ['sales', 'intern', 'recruiter'],
  research_min_score: 70,
  limit_per_source: 50,
};

const SKILLS = [
  'Python',
  'PyTorch',
  'LangChain',
  'RAG',
  'AWS',
  'Docker',
  'SQL',
  'FastAPI',
  'LLM evals',
  'Kubernetes',
];
const pick = (list, start, count) =>
  Array.from({ length: count }, (_, i) => list[(start + i) % list.length]);
const jobId = (job) =>
  createHash('sha1')
    .update(`${job.company}|${job.title}|${job.location}`.toLowerCase())
    .digest('hex')
    .slice(0, 16);

function buildLead([title, company, location, source, remote, seniority, score, fate = ''], index) {
  const slug = company.toLowerCase().replaceAll(/[^a-z]+/g, '');
  const postedAt = new Date(Date.UTC(2026, 10, 10) - index * 9 * 3600_000).toISOString();
  const job = {
    source,
    url: `https://${slug}.example.com/careers/${index + 100}`,
    title,
    company,
    location,
    description: `${company} is hiring a ${title}.\n\nYou will design, ship and operate machine learning systems used by real customers, working with a small senior team.\n\nWhat we look for:\n- Strong ${pick(SKILLS, index, 3).join(', ')}\n- Experience taking models to production\n- Clear written communication\n\nWe offer flexible hours, a learning budget and equity.\n\nAbout the team: we are twelve engineers across four time zones. We write things down, review each other's work within a day and deploy many times a week.\n\nHow to apply: send your CV and a short note on a system you shipped. The process is a 30-minute intro call, a paid take-home exercise and a half-day of conversations with the team.`,
    posted_at: postedAt,
    remote: remote === 'remote',
    salary: '',
    tags: pick(SKILLS, index, 3),
  };
  const extracted = {
    role_family: title.includes('Data Scientist') ? 'Data Scientist' : 'AI Engineer',
    seniority,
    remote_policy: remote,
    contract_type: 'full_time',
    locations: [location],
    salary_min: 70000 + (index % 6) * 8000,
    salary_max: 95000 + (index % 6) * 10000,
    salary_currency: location.includes('US') ? 'USD' : 'EUR',
    required_skills: pick(SKILLS, index, 4),
    nice_to_have_skills: pick(SKILLS, index + 5, 2),
    years_experience: 2 + (index % 5),
    summary: `${company} needs a ${title} to build and run production ML features. The role is ${remote} and reports to the head of engineering.`,
  };
  // Every fourth posting is an "older" lead: extracted before the bullet fields
  // and the score breakdown existed, and with a few facts the posting never stated.
  // Its remote policy comes only from the board's flag (the lead keeps 'remote').
  const older = index % 4 === 3;
  if (older) {
    Object.assign(extracted, {
      salary_min: null,
      salary_max: null,
      contract_type: 'unknown',
      years_experience: null,
      remote_policy: remote === 'remote' ? 'unknown' : remote,
    });
  } else {
    Object.assign(extracted, {
      company_one_liner: `${company} builds applied-AI software for its industry.`,
      responsibilities: [
        'Ship ML features from prototype to production',
        `Own the ${pick(SKILLS, index, 1)[0]} services and their evaluation`,
        'Work with product on what to build next',
        'Share on-call for the model gateway',
      ],
      requirements: [
        `${2 + (index % 5)}+ years building ML systems`,
        ...pick(SKILLS, index, 3).map((skill) => `Hands-on ${skill}`),
        'Clear written communication',
      ],
      benefits: [
        'Equity',
        'Learning budget',
        'Flexible hours',
        remote === 'remote' ? 'Home-office stipend' : 'Relocation help',
      ],
    });
  }
  const skillPoints = Math.round(score * 0.45);
  const scoreDetail = {
    ...(older
      ? {}
      : {
          breakdown: {
            skills: skillPoints,
            role: Math.round(score * 0.25),
            seniority: Math.round(score * 0.15),
            logistics: score - skillPoints - Math.round(score * 0.25) - Math.round(score * 0.15),
          },
        }),
    score,
    rationale: `Strong overlap on ${pick(SKILLS, index, 2).join(' and ')}; the ${seniority} level matches your experience. ${score >= 70 ? 'The domain is close to your recent projects.' : 'The domain is some distance from your recent projects.'}`,
    matched_skills: pick(SKILLS, index, 3),
    missing_skills: pick(SKILLS, index + 6, score >= 70 ? 1 : 3),
    concerns:
      score >= 80
        ? []
        : [
            `${remote === 'onsite' ? 'On-site only' : 'Salary range not confirmed'} for ${location}.`,
          ],
  };
  const brief = {
    what_they_do: `${company} builds software for its industry with a growing applied-AI team.`,
    stage_and_funding: `Series ${'ABC'[index % 3]}, about ${40 + index * 7} people.`,
    ai_stack: `${pick(SKILLS, index + 1, 3).join(', ')}; models served behind an internal gateway.`,
    hiring_contact: 'Careers page lists the Head of Engineering as hiring manager.',
    sources: [`https://${slug}.example.com/about`, `https://news.example.com/${slug}-funding`],
  };
  return {
    seed: { fate, extracted, scoreDetail, brief },
    lead: {
      job_id: jobId(job),
      status: 'new',
      score: null,
      title,
      company,
      location,
      source,
      url: job.url,
      remote_policy: remote,
      seniority,
      role_family: extracted.role_family,
      posted_at: postedAt,
      updated_at: postedAt,
      job,
      extracted: null,
      score_detail: null,
      brief: null,
      application: null,
      pipeline_error: null,
    },
  };
}

/** Fills in what each stage adds, up to and including `stage`. */
export function advanceLead(lead, seed, stage, minScore) {
  const scored = {
    ...lead,
    extracted: seed.extracted,
    score_detail: seed.scoreDetail,
    score: seed.scoreDetail.score,
    status: 'scored',
  };
  if (stage === 'scored' || seed.scoreDetail.score < minScore) return scored;
  return { ...scored, brief: seed.brief, status: 'researched' };
}

export const APPLICATION_FILES = ['cv_tailored.pdf', 'cv_preview.png', 'cover_letter.txt'];
const application = (lead, extra = {}) => ({
  dir: `applications/${lead.job_id}`,
  files: APPLICATION_FILES,
  unanswered: [],
  error: '',
  cost_usd: 1.25,
  filled_fields: [],
  ...extra,
});

/** What the mock applier "filled" on a form. */
export const FILLED_FIELDS = [
  'First name',
  'Last name',
  'Email',
  'Phone',
  'LinkedIn URL',
  'CV upload',
  'Cover letter',
  'Current location',
  'Work authorisation',
];

/** A few existing leads sit further along the application status machine. */
const APPLICATION_STATES = {
  2: (lead) => ({ status: 'cv_ready', application: application(lead) }),
  4: (lead) => ({
    status: 'form_filled',
    application: application(lead, {
      unanswered: ['What is your notice period?', 'Do you need visa sponsorship?'],
      filled_fields: FILLED_FIELDS,
      cost_usd: 1.71,
    }),
  }),
  6: (lead) => ({ status: 'applied', application: application(lead) }),
  // A form fill that did not finish keeps the CV: back to cv_ready with the reason.
  7: (lead) => ({
    status: 'cv_ready',
    application: application(lead, {
      error: 'The careers page asks you to sign in before it shows the form.',
    }),
  }),
  // The applier was stopped mid-task and never reported back: needs "Reset this lead".
  8: () => ({ status: 'tailoring' }),
  9: () => ({ status: 'skipped' }),
  11: (lead) => ({
    status: 'failed',
    application: application(lead, {
      files: [],
      error: 'polishmycv exited with code 1: could not fit the CV on one page.',
      cost_usd: null,
    }),
  }),
  // Tailoring again failed, but the CV from the earlier attempt is still there.
  13: (lead) => ({
    status: 'failed',
    application: application(lead, { error: 'Claude Code session timed out after 60 minutes.' }),
  }),
};

/** Two existing leads on which a pipeline step failed: what the lead keeps is what came before it. */
const PIPELINE_FAILURES = {
  1: () => ({
    status: 'scored',
    brief: null,
    pipeline_error: {
      agent: 'researcher',
      error: 'Web search found nothing about the company after 3 attempts',
    },
  }),
  23: () => ({
    status: 'new',
    score: null,
    extracted: null,
    score_detail: null,
    brief: null,
    pipeline_error: { agent: 'extractor', error: 'Model returned invalid JSON after 3 attempts.' },
  }),
};

export const runJobs = RUN_SEEDS.map((seed, index) => buildLead(seed, index));

export const existingLeads = LEAD_SEEDS.map((seed, index) => {
  const built = buildLead(seed, index + RUN_SEEDS.length);
  const lead = advanceLead(built.lead, built.seed, 'researched', settings.research_min_score);
  const state = APPLICATION_STATES[index] ?? PIPELINE_FAILURES[index];
  return { ...built, lead: { ...lead, ...state?.(lead) } };
});

export { application as buildApplication };
