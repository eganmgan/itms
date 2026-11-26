CREATE OR REPLACE FUNCTION guard_support_resolution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  closer_role text;
BEGIN
  IF NEW.kind = 'support'
     AND NEW.status = 'closed'
     AND NEW.closed_by IS DISTINCT FROM OLD.closed_by THEN
    SELECT r.name
    INTO closer_role
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.id = NEW.closed_by
      AND u.is_active;

    IF NOT (
      closer_role IN ('admin', 'super_admin')
      OR (
        NEW.closed_by IS NOT DISTINCT FROM NEW.primary_owner_id
        AND closer_role = 'it_team'
      )
      OR (
        closer_role = 'employee'
        AND EXISTS (
          SELECT 1
          FROM chat_members
          WHERE channel_id = NEW.id
            AND user_id = NEW.closed_by
        )
      )
    ) THEN
      RAISE EXCEPTION 'Only the assigned support member, an employee chat member, or an administrator can close support'
        USING ERRCODE = '23514', CONSTRAINT = 'support_resolution';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
