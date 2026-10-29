CREATE TABLE task_island_activities (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    activity TEXT NOT NULL CHECK(activity IN ('read','run','ball')),
    PRIMARY KEY(task_id,activity)
) STRICT;
