"""
scripts/create_user.py
──────────────────────
Bulk-create university users without touching SQL.
Edit the USERS_TO_CREATE list and run:

    python scripts/create_user.py

Safe to run multiple times — skips emails that already exist.
"""

import asyncio
import os
import bcrypt
import asyncpg
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres123@localhost:5432/cafeteria",
)

# ── Add your users here ───────────────────────────────────────
# Format: (email, display_name, password, role)
# Roles:  student | staff | admin
#
# Student email format: firstname.STUDENTID@ejust.edu.eg
# Staff  email format:  any name @ejust.edu.eg
# ─────────────────────────────────────────────────────────────

USERS_TO_CREATE = [
    # Students
    ("mohamed.120230230@ejust.edu.eg", "Mohamed Ahmed",    "Pass1234!", "student"),
    ("sara.120230231@ejust.edu.eg",    "Sara Ali",         "Pass1234!", "student"),
    ("ahmed.120230232@ejust.edu.eg",   "Ahmed Hassan",     "Pass1234!", "student"),
    ("nour.120230233@ejust.edu.eg",    "Nour Ibrahim",     "Pass1234!", "student"),

    # Staff
    ("staff.kitchen@ejust.edu.eg",     "Kitchen Staff",    "Pass1234!", "staff"),
    ("staff.cashier@ejust.edu.eg",     "Cashier",          "Pass1234!", "staff"),

    # Admin
    ("admin.cafeteria@ejust.edu.eg", "Cafeteria Admin", "Admin1234!", "admin"),
]


async def create_users():
    print(f"\nConnecting to database...")
    conn = await asyncpg.connect(DATABASE_URL)
    print("Connected.\n")

    created = 0
    skipped = 0
    failed  = 0

    for email, display_name, password, role in USERS_TO_CREATE:
        try:
            # Check if already exists
            exists = await conn.fetchval(
                "SELECT id FROM users WHERE email = $1",
                email.lower().strip(),
            )
            if exists:
                print(f"  SKIP   {email} (already exists)")
                skipped += 1
                continue

            # Hash password
            password_hash = bcrypt.hashpw(
                password.encode(), bcrypt.gensalt(rounds=12)
            ).decode()

            # Insert user
            await conn.execute(
                """INSERT INTO users (email, display_name, password_hash, role, status)
                   VALUES ($1, $2, $3, $4, 'active')""",
                email.lower().strip(),
                display_name,
                password_hash,
                role,
            )
            print(f"  OK     {email:<45} [{role:<7}]  password={password}")
            created += 1

        except Exception as e:
            print(f"  FAIL   {email} → {e}")
            failed += 1

    await conn.close()

    print(f"\n{'─'*60}")
    print(f"  Created : {created}")
    print(f"  Skipped : {skipped} (already existed)")
    print(f"  Failed  : {failed}")
    print(f"{'─'*60}\n")

    if created > 0:
        print("Users can now log in at http://localhost:5173/login")
        print("All new users have the password shown above.\n")


if __name__ == "__main__":
    asyncio.run(create_users())
