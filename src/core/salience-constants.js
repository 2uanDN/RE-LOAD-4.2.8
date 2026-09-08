export const SALIENCE_LEVELS = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  TRACE: 0
};

export const VAL_TO_SALIENCE = {
  3: 'high',
  2: 'medium',
  1: 'low',
  0: 'trace'
};

export const ROLE_TO_SALIENCE = {
  'initiator': 'high',
  'primary_target': 'high',
  'active_reactor': 'high',
  'supportive_actor': 'medium',
  'silent_observer': 'medium',
  'ambient_presence': 'low',
  'offscreen_catalyst': 'trace',
  'mentioned_entity': 'trace'
};
