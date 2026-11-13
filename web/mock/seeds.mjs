/** Raw fixture data for the mock orchestrator; fixtures.mjs expands it into API objects. */

/** [adapter name, label, enabled] */
export const SOURCES = [
  ['jobicy', 'Jobicy', true],
  ['remoteok', 'Remote OK', true],
  ['remotive', 'Remotive', true],
  ['hackernews', 'Hacker News', true],
  ['arbeitnow', 'Arbeitnow', true],
  ['weworkremotely', 'We Work Remotely', false],
];

/** [id, label, kind, model, description] */
export const AGENTS = [
  [
    'scout',
    'Scout',
    'tool',
    '',
    'Pulls new postings from every enabled source and de-duplicates them.',
  ],
  [
    'filter',
    'Filter',
    'tool',
    '',
    'Keeps postings whose title matches a target keyword; drops excluded ones.',
  ],
  [
    'extractor',
    'Extractor',
    'llm',
    'claude-haiku-4-5',
    'Reads the posting text into structured facts: seniority, salary, skills.',
  ],
  [
    'scorer',
    'Scorer',
    'llm',
    'claude-sonnet-4-5',
    'Scores the job against your CV and explains the fit.',
  ],
  [
    'researcher',
    'Researcher',
    'deep',
    'claude-sonnet-4-5',
    'Researches the company on the web for postings above the score threshold.',
  ],
  [
    'applier',
    'Applier',
    'human',
    'claude-code',
    'Tailors your CV and fills the application form, only when you press the button.',
  ],
];

const graphNode = (id) => ({
  id,
  label: { __start__: 'Start', __end__: 'End' }[id] ?? id.replaceAll('_', ' '),
});
const graphEdge = (source, target, conditional = false) => ({ source, target, conditional });
/** A graph whose nodes run one after the other, start to end. */
function chain(...steps) {
  const ids = ['__start__', ...steps, '__end__'];
  return {
    nodes: ids.map(graphNode),
    edges: ids.slice(1).map((id, index) => graphEdge(ids[index], id)),
  };
}

/** agent id -> its LangGraph graph, shaped like the agents publish it. */
export const GRAPHS = {
  extractor: chain('facts', 'highlights', 'tidy'),
  scorer: chain('judge', 'rubric'),
  // The deep agent: the model calls tools in a loop until it has the brief.
  researcher: {
    nodes: ['__start__', 'model', 'tools', '__end__'].map(graphNode),
    edges: [
      graphEdge('__start__', 'model'),
      graphEdge('model', 'tools', true),
      graphEdge('tools', 'model'),
      graphEdge('model', '__end__', true),
    ],
  },
};

/** agent id -> what an agent that is not a graph does, in order. */
export const STEPS = {
  scout: ['Fetch every enabled source', 'Rank postings', 'Forward the new ones'],
  filter: ['Title keywords', 'Title embedding', 'Posting text'],
  applier: ['Tailor CV (polishmycv)', 'Fill the form', 'Stop before Submit'],
};

/** The agents that run a pool of workers; the scout and the applier are always one. */
export const POOLED = ['filter', 'extractor', 'scorer', 'researcher'];

/** [title, company, location, source, remote policy, seniority, score] */
export const LEAD_SEEDS = [
  ['Senior AI Engineer', 'Lumen Health', 'Remote (EU)', 'jobicy', 'remote', 'senior', 93],
  ['LLM Engineer, Agents', 'Northwind Labs', 'Remote', 'remoteok', 'remote', 'senior', 91],
  ['Machine Learning Engineer', 'Parcelwise', 'Berlin, Germany', 'arbeitnow', 'hybrid', 'mid', 88],
  ['Staff Data Scientist', 'Tidal Analytics', 'Remote (US)', 'remotive', 'remote', 'lead', 86],
  ['GenAI Solutions Engineer', 'Kestrel AI', 'London, UK', 'hackernews', 'hybrid', 'senior', 84],
  ['Applied Scientist, NLP', 'Verba', 'Remote', 'jobicy', 'remote', 'senior', 82],
  ['AI Engineer (RAG)', 'Docklight', 'Amsterdam, NL', 'arbeitnow', 'hybrid', 'mid', 81],
  ['ML Platform Engineer', 'Granite Cloud', 'Remote (EU)', 'remotive', 'remote', 'senior', 79],
  ['Data Scientist, Pricing', 'Farely', 'Madrid, Spain', 'jobicy', 'hybrid', 'mid', 77],
  ['Senior ML Engineer, Search', 'Findr', 'Remote', 'remoteok', 'remote', 'senior', 76],
  ['AI Agent Developer', 'Quillbot Works', 'Remote', 'hackernews', 'remote', 'mid', 74],
  [
    'Machine Learning Engineer, Vision',
    'Optiq',
    'Munich, Germany',
    'arbeitnow',
    'onsite',
    'mid',
    72,
  ],
  ['Lead Data Scientist', 'Meridian Bank', 'Zurich, CH', 'jobicy', 'hybrid', 'lead', 70],
  ['MLOps Engineer', 'Stackforge', 'Remote (EU)', 'remotive', 'remote', 'mid', 68],
  ['AI Product Engineer', 'Hatchway', 'Lisbon, Portugal', 'remoteok', 'hybrid', 'mid', 66],
  ['Data Scientist, Growth', 'Pondr', 'Remote', 'jobicy', 'remote', 'mid', 64],
  ['NLP Engineer', 'Lexicon Legal', 'Paris, France', 'arbeitnow', 'hybrid', 'senior', 63],
  [
    'Machine Learning Researcher',
    'Aster Robotics',
    'Zurich, CH',
    'hackernews',
    'onsite',
    'senior',
    61,
  ],
  [
    'Senior Data Scientist, Risk',
    'Clearpay Systems',
    'Dublin, Ireland',
    'remotive',
    'hybrid',
    'senior',
    58,
  ],
  ['AI Engineer, Voice', 'Sonant', 'Remote (US)', 'remoteok', 'remote', 'mid', 57],
  ['Analytics Engineer', 'Brightloop', 'Remote', 'jobicy', 'remote', 'mid', 54],
  [
    'ML Engineer, Recommendations',
    'Shelfie',
    'Stockholm, Sweden',
    'arbeitnow',
    'hybrid',
    'mid',
    52,
  ],
  ['Data Scientist', 'Agrimetric', 'Remote (EU)', 'remotive', 'remote', 'junior', 49],
  [
    'Computer Vision Engineer',
    'Skyline Drones',
    'Tallinn, Estonia',
    'hackernews',
    'onsite',
    'mid',
    47,
  ],
  ['Junior ML Engineer', 'Tinybird Apps', 'Remote', 'remoteok', 'remote', 'junior', 44],
  ['Data Engineer, ML Infra', 'Coldstart', 'Warsaw, Poland', 'jobicy', 'hybrid', 'mid', 41],
  [
    'Principal AI Architect',
    'Consulta Group',
    'Frankfurt, Germany',
    'arbeitnow',
    'onsite',
    'principal',
    38,
  ],
  [
    'Quantitative Researcher',
    'Halberd Capital',
    'London, UK',
    'hackernews',
    'onsite',
    'senior',
    33,
  ],
  ['BI Analyst with ML', 'Retailio', 'Remote', 'remotive', 'remote', 'junior', 27],
  [
    'Machine Learning Engineer, Embedded',
    'Voltcore',
    'Eindhoven, NL',
    'jobicy',
    'onsite',
    'senior',
    22,
  ],
];

/** Postings the scripted run discovers. `fate` says where one leaves the pipeline early. */
export const RUN_SEEDS = [
  ['Senior AI Engineer, Agents', 'Harbor AI', 'Remote (EU)', 'jobicy', 'remote', 'senior', 94],
  [
    'Enterprise Sales Engineer, AI',
    'Pipedrive Pro',
    'Remote',
    'jobicy',
    'remote',
    'mid',
    0,
    'drop:excluded keyword "sales"',
  ],
  ['ML Engineer, Forecasting', 'Gridpulse', 'Copenhagen, Denmark', 'jobicy', 'hybrid', 'mid', 78],
  ['LLM Application Engineer', 'Mosaic Docs', 'Remote', 'remoteok', 'remote', 'senior', 87],
  [
    'Frontend Developer',
    'Mosaic Docs',
    'Remote',
    'remoteok',
    'remote',
    'mid',
    0,
    'drop:no target keyword in title',
  ],
  ['Data Scientist, Marketplace', 'Lendable Goods', 'Remote (US)', 'remoteok', 'remote', 'mid', 59],
  [
    'Machine Learning Engineer',
    'Cobalt Bio',
    'Basel, CH',
    'remotive',
    'onsite',
    'senior',
    0,
    'fail',
  ],
  ['AI Engineer, Evaluation', 'Benchwise', 'Remote', 'remotive', 'remote', 'mid', 73],
  [
    'ML Engineering Intern',
    'Benchwise',
    'Remote',
    'remotive',
    'remote',
    'intern',
    0,
    'drop:excluded keyword "intern"',
  ],
  ['GenAI Engineer', 'Tessel Studio', 'Barcelona, Spain', 'hackernews', 'hybrid', 'mid', 81],
  ['Senior Data Scientist', 'Orbit Freight', 'Rotterdam, NL', 'hackernews', 'hybrid', 'senior', 66],
  ['Applied ML Engineer', 'Kindling', 'Remote (EU)', 'hackernews', 'remote', 'mid', 45],
];
