import type { UserProfile } from './types';

export interface ProfileField {
  key: string;
  label: string;
  /** An example answer, shown as the placeholder. */
  example?: string;
  type?: 'text' | 'email' | 'tel' | 'url';
}

export interface ProfileGroup {
  section: keyof UserProfile;
  title: string;
  hint: string;
  fields: ProfileField[];
}

/** The fields of `profile.yaml`, in the order the Setup page shows them. */
export const PROFILE_GROUPS: ProfileGroup[] = [
  {
    section: 'preferences',
    title: 'Job preferences',
    hint: 'The scorer compares each job with these (logistics and seniority points). Empty means no preference.',
    fields: [
      { key: 'locations', label: 'Locations', example: 'Barcelona, or remote in EU/US time zones' },
      {
        key: 'remote',
        label: 'Remote policy',
        example: 'remote or hybrid; no onsite outside Barcelona',
      },
      { key: 'contract_types', label: 'Contract types', example: 'full-time or contract' },
      { key: 'minimum_salary', label: 'Minimum salary', example: 'EUR 90,000 per year' },
      { key: 'seniority', label: 'Seniority', example: 'senior or lead' },
      { key: 'avoid', label: 'Avoid', example: 'defence, gambling' },
    ],
  },
  {
    section: 'application',
    title: 'Contact details',
    hint: 'Only the form-filling agent reads the application answers. They never go to a local model.',
    fields: [
      { key: 'full_name', label: 'Full name' },
      { key: 'email', label: 'E-mail', type: 'email' },
      { key: 'phone', label: 'Phone', type: 'tel', example: '+34 600 000 000' },
      { key: 'city_and_country', label: 'City and country', example: 'Barcelona, Spain' },
      {
        key: 'linkedin_url',
        label: 'LinkedIn',
        type: 'url',
        example: 'https://www.linkedin.com/in/…',
      },
      { key: 'website_url', label: 'Website', type: 'url' },
      { key: 'github_url', label: 'GitHub', type: 'url' },
    ],
  },
  {
    section: 'application',
    title: 'Work and terms',
    hint: 'A form question with no answer here is left blank for you.',
    fields: [
      {
        key: 'work_authorisation',
        label: 'Work authorisation',
        example: 'EU citizen; no sponsorship needed in the EU',
      },
      {
        key: 'needs_visa_sponsorship',
        label: 'Needs visa sponsorship',
        example: 'no (EU); yes (US)',
      },
      { key: 'salary_expectation', label: 'Salary expectation', example: 'EUR 100,000' },
      { key: 'notice_period', label: 'Notice period', example: '1 month' },
      { key: 'willing_to_relocate', label: 'Willing to relocate', example: 'within the EU' },
      { key: 'years_of_experience', label: 'Years of experience', example: '8' },
      {
        key: 'how_did_you_hear',
        label: 'How did you hear about us',
        example: 'Company careers page',
      },
    ],
  },
  {
    section: 'application',
    title: 'Equal-opportunity questions',
    hint: 'Optional. Empty: the agent chooses "Prefer not to say".',
    fields: [
      { key: 'gender', label: 'Gender' },
      { key: 'ethnicity', label: 'Ethnicity' },
      { key: 'veteran_status', label: 'Veteran status' },
      { key: 'disability_status', label: 'Disability status' },
    ],
  },
];

/** How many of a group's fields have an answer. */
export const answered = (profile: UserProfile, group: ProfileGroup): number =>
  group.fields.filter((field) => profile[group.section][field.key]?.trim()).length;
