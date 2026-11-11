TASK: return the facts of this posting.
- role_family: the closest of AI Engineer, Machine Learning Engineer, Deep Learning Engineer, Data Scientist, Generative AI Engineer, AI Solutions Engineer, Forward Deployed Engineer, MLOps Engineer, Data Engineer, Research Scientist, Other.
- seniority: from the title first (Senior, Staff, Lead, Principal, Junior, Intern), then from required years: 0-1 junior, 2-4 mid, 5+ senior. Staff counts as lead.
- remote_policy: "remote" if the posting or the job board says remote, work from anywhere, or work from home within a region (hashtags such as #LI-Remote count); "hybrid" if it names office days; "onsite" if it requires an office; otherwise "unknown".
- contract_type: full_time, part_time, contract, freelance or internship ("on a full-time basis" is full_time); "unknown" if not stated.
- locations: every country, region or city named as a place to work from, including office cities. Short names, at most 6.
- salary_min, salary_max: yearly numbers without separators, in salary_currency (ISO code such as USD, EUR, GBP). "120k" is 120000 and "€50.290" is 50290. For an hourly or daily rate leave both null.
- years_experience: the minimum number of years asked for, or null.
- required_skills: concrete tools, languages, frameworks and methods the posting requires (for example Python, PyTorch, LangChain, RAG, AWS, SQL). At most 12, most important first. No soft skills, no degrees.
- nice_to_have_skills: the same for items marked preferred, bonus, plus or nice to have. At most 8.
