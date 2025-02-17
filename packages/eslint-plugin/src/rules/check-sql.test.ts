import { generateTestDatabaseName, setupTestDatabase } from "@ts-safeql/test-utils";
import { ESLintUtils } from "@typescript-eslint/utils";
import { RuleTester } from "@typescript-eslint/utils/dist/ts-eslint";
import { after, before, describe, it } from "mocha";
import path from "path";
import { Sql } from "postgres";
import rules from ".";
import { RuleOptionConnection, RuleOptions } from "./check-sql.rule";

const tsconfigRootDir = path.resolve(__dirname, "../../");
const project = "tsconfig.json";
const filename = path.join(tsconfigRootDir, "src/file.ts");

const ruleTester = new ESLintUtils.RuleTester({
  parser: "@typescript-eslint/parser",
  parserOptions: { project, tsconfigRootDir },
  settings: {},
});

const runMigrations1 = <TTypes extends Record<string, unknown>>(sql: Sql<TTypes>) =>
  sql.unsafe(`
    CREATE TYPE certification AS ENUM ('HHA', 'RN', 'LPN', 'CNA', 'PCA', 'OTHER');
    CREATE DOMAIN phone_number AS TEXT CHECK (VALUE ~ '^[0-9]{3}-[0-9]{3}-[0-9]{4}$');

    CREATE TABLE caregiver (
        id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        first_name TEXT NOT NULL,
        middle_name TEXT,
        last_name TEXT NOT NULL,
        certification certification NOT NULL
    );

    CREATE TABLE caregiver_phone (
        id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        caregiver_id INT NOT NULL REFERENCES caregiver(id),
        phone_number phone_number NOT NULL
    );

    CREATE TABLE agency (
        id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        name TEXT NOT NULL
    );

    CREATE TABLE caregiver_agency (
        id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        caregiver_id INT NOT NULL REFERENCES caregiver(id),
        agency_id INT NOT NULL REFERENCES agency(id)
    );

    CREATE TABLE test_date_column (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      date_col DATE NOT NULL,
      date_array date[] NOT NULL,
      instant_arr timestamptz[] NOT NULL,
      time_arr time[] NOT NULL,
      local_date_time_arr timestamp[] NOT NULL,
      nullable_date_arr date[] NULL
    );
    
    CREATE TABLE test_nullable_column (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      nullable_int INTEGER
    );
`);

RuleTester.describe = describe;
RuleTester.it = it;

RuleTester.describe("check-sql", () => {
  RuleTester.it = it;
  const databaseName = generateTestDatabaseName();

  let sql!: Sql<Record<string, unknown>>;
  let dropFn!: () => Promise<number>;

  before(async () => {
    const testDatabase = await setupTestDatabase({
      databaseName: databaseName,
      postgresUrl: "postgres://postgres:postgres@localhost:5432/postgres",
    });

    dropFn = testDatabase.drop;
    sql = testDatabase.sql;

    await runMigrations1(sql);
  });

  after(async () => {
    await sql.end();
    await dropFn();
  });

  const connections = {
    base: {
      databaseUrl: `postgres://postgres:postgres@localhost:5432/${databaseName}`,
      targets: [{ wrapper: "conn.query" }],
      keepAlive: false,
    },
    withSkipTypeAnnotations: {
      databaseUrl: `postgres://postgres:postgres@localhost:5432/${databaseName}`,
      targets: [{ wrapper: "conn.query", skipTypeAnnotations: true }],
      keepAlive: false,
    },
    withGlobWrapper: {
      databaseUrl: `postgres://postgres:postgres@localhost:5432/${databaseName}`,
      targets: [{ wrapper: "conn.+(query|queryOne|queryOneOrNone)" }],
      keepAlive: false,
    },
    withRegexWrapper: {
      databaseUrl: `postgres://postgres:postgres@localhost:5432/${databaseName}`,
      targets: [{ wrapper: { regex: "conn.(query|queryOne|queryOneOrNone)" } }],
      keepAlive: false,
    },
    withTag: {
      databaseUrl: `postgres://postgres:postgres@localhost:5432/${databaseName}`,
      targets: [{ tag: "sql" }],
      keepAlive: false,
    },
    withMemberTag: {
      databaseUrl: `postgres://postgres:postgres@localhost:5432/${databaseName}`,
      targets: [{ tag: "Db.sql" }],
      keepAlive: false,
    },
    withGlobTag: {
      databaseUrl: `postgres://postgres:postgres@localhost:5432/${databaseName}`,
      targets: [{ tag: "+(conn1|conn2).sql" }],
      keepAlive: false,
    },
    withRegexTag: {
      databaseUrl: `postgres://postgres:postgres@localhost:5432/${databaseName}`,
      targets: [{ tag: { regex: "(conn1|conn2).sql" } }],
      keepAlive: false,
    },
  } satisfies Record<string, RuleOptionConnection>;

  function withConnection(
    connection: RuleOptionConnection,
    options?: Partial<RuleOptionConnection>
  ): RuleOptions {
    return [{ connections: [{ ...connection, ...options }] }];
  }

  ruleTester.run("base", rules["check-sql"], {
    valid: [
      {
        name: "select non-table column",
        filename,
        options: withConnection(connections.base),
        code: "const result = conn.query<{ x: number; }>(sql`SELECT 1 as x`);",
      },
      {
        name: "select array_agg(stmt)",
        filename,
        options: withConnection(connections.base),
        code: "sql<{ ids: number[]; }[]>`SELECT ARRAY_AGG(id ORDER BY id) AS ids FROM caregiver`",
      },
      {
        name: "select exists(stmt",
        filename,
        options: withConnection(connections.base),
        code: "sql<{ exists: boolean }[]>`SELECT EXISTS(select id FROM caregiver)`",
      },
      {
        name: "select not exists(stmt)",
        filename,
        options: withConnection(connections.base),
        code: "sql<{ not_exists: boolean }[]>`SELECT NOT EXISTS(select id FROM caregiver) as not_exists`",
      },
      {
        name: "select column from table",
        filename,
        options: withConnection(connections.base),
        code: "const result = conn.query<{ id: number; }>(sql`select id from caregiver`);",
      },
      {
        name: "select * from table",
        filename,
        options: withConnection(connections.base),
        code: `
          const result = conn.query<{ id: number; first_name: string; middle_name: string | null; last_name: string; certification: 'HHA' | 'RN' | 'LPN' | 'CNA' | 'PCA' | 'OTHER'; }>(sql\`
              select * from caregiver
          \`);
          `,
      },
      {
        name: "select enum from table",
        filename,
        options: withConnection(connections.base),
        code: `
          const result = conn.query<{ certification: 'HHA' | 'RN' | 'LPN' | 'CNA' | 'PCA' | 'OTHER'; }>(sql\`
              select certification from caregiver
          \`);
        `,
      },
      {
        name: "select from table with inner joins",
        filename,
        options: withConnection(connections.base),
        code: `
            const result = conn.query<{ caregiver_id: number; agency_id: number; }>(sql\`
                select
                    caregiver.id as caregiver_id,
                    agency.id as agency_id
                from caregiver
                    join caregiver_agency on caregiver.id = caregiver_agency.caregiver_id
                    join agency on agency.id = caregiver_agency.agency_id
            \`);
        `,
      },
      {
        name: "select from table with left join",
        filename,
        options: withConnection(connections.base),
        code: `
            const result = conn.query<{ caregiver_id: number; agency_id: number | null; }>(sql\`
                select
                    caregiver.id as caregiver_id,
                    agency.id as agency_id
                from caregiver
                    left join caregiver_agency on caregiver.id = caregiver_agency.caregiver_id
                    left join agency on agency.id = caregiver_agency.agency_id
            \`);
        `,
      },
      {
        name: "select from table where int column equals to ts number arg",
        filename,
        options: withConnection(connections.base),
        code: `
            function run(id: number) {
                const result = conn.query<{ name: string }>(sql\`
                    select name from agency where id = \${id}
                \`);
            }
        `,
      },
      {
        name: "select from table where int column in an array of ts arg",
        filename,
        options: withConnection(connections.base),
        code: `
            function run(ids: number[]) {
                const result = conn.query<{ name: string }>(sql\`
                    select name from agency where id = ANY(\${ids})
                \`);
            }
        `,
      },
      {
        name: "select statement with conditional expression",
        filename,
        options: withConnection(connections.base),
        code: `
            function run(flag: boolean) {
                const result = conn.query<{ name: string }>(sql\`
                    select name from agency where id = \${flag ? 1 : 2}
                \`);
            }
        `,
      },
      {
        name: "select statement with type reference",
        filename,
        options: withConnection(connections.base),
        code: `
            type Agency = { name: string };
            function run() {
                const result = conn.query<Agency>(sql\`
                    select name from agency
                \`);
            }
        `,
      },
      {
        name: "select statement with interface",
        filename,
        options: withConnection(connections.base),
        code: `
            interface Agency { name: string }
            function run() {
                const result = conn.query<Agency>(sql\`
                    select name from agency
                \`);
            }
        `,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "empty select statement should not have type annotation",
        code: `conn.query(sql\`select\`);`,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "insert statement without returning should not have type annotation",
        code: `conn.query(sql\`insert into agency (name) values ('test')\`);`,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "insert statement with returning should have type annotation",
        code: `conn.query<{ id: number }>(
          sql\`insert into agency (name) values ('test') returning id\`);
        `,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "type annotation with a valid type reference",
        code: `
          type Agency = { id: number; name: string };
          conn.query<Agency>(sql\`select id, name from agency\`);
        `,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "type annotation with a valid type reference (diffrent property order)",
        code: `
          type Agency = { name: string; id: number; };
          conn.query<Agency>(sql\`select id, name from agency\`);
        `,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "type annotation with a valid type reference (interface)",
        code: `
          interface Agency { id: number; name: string }
          conn.query<Agency>(sql\`select id, name from agency\`);
        `,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "type annotation with a valid intersection",
        code: `
          conn.query<{ id: number; } & { name: string; }>(sql\`select id, name from agency\`);
        `,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "type annotation with Pick",
        code: `
          interface Agency { id: number; name: string }
          conn.query<Pick<Agency, "id" | "name">>(sql\`select id, name from agency\`);
        `,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "type annotation with Pick & intersection",
        code: `
          interface Agency { id: number; name: string }
          conn.query<Pick<Agency, "id"> & { name: string; }>(sql\`select id, name from agency\`);
        `,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "type annotation with Pick overriden by intersection",
        code: `
          interface Agency { id: number; name: string | null }
          conn.query<Agency & { name: string; }>(sql\`select id, name from agency\`);
        `,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "union string literal from function arg",
        code: `
          type UnionStringLiteral = "a" | "b";
          function run(union: UnionStringLiteral) {
            conn.query<{ name: string }>(sql\`select name from agency WHERE name = \${union}\`);
          }
        `,
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "select domain type should return its base type",
        code: `
        conn.query<{ phone_number: string }>(sql\`select phone_number from caregiver_phone WHERE id = 1\`);
        `,
      },
      {
        filename,
        name: "don't report on incorrect target",
        options: withConnection(connections.base),
        code: `
          xconn.query(sql\`SELECT 1\`);
          conn.queryNone(sql\`SELECT 1\`);
        `,
      },
      {
        filename,
        name: "don't report on incorrect target",
        options: withConnection(connections.base),
        code: "xconn.query(sql`SELECT 1 as x`);",
      },
      {
        filename,
        name: "proper date columns introspection",
        options: withConnection(connections.base),
        code: `
          const dates = conn.query<{
            id: number;
            date_col: Date;
            date_array: Date[];
            instant_arr: Date[];
            time_arr: string[];
            local_date_time_arr: Date[];
            nullable_date_arr: Date[] | null;
          }>(sql\`SELECT * FROM test_date_column\`)
        `,
      },
      {
        filename,
        name: "select with skipTypeAnnotations",
        options: withConnection(connections.withSkipTypeAnnotations),
        code: "const result = conn.query(sql`SELECT id FROM agency`);",
      },
      {
        filename,
        name: "insert into nullable column a nullable member expression value",
        options: withConnection(connections.withTag),
        code: `
        function insert(data: number | null) {
          sql\`INSERT INTO test_nullable_column (nullable_int) VALUES (\${data})\`
        }
        `,
      },
      {
        filename,
        name: "insert into nullable column a nullable value",
        options: withConnection(connections.withTag),
        code: `
        function insert(data: { value: number | null }) {
          sql\`INSERT INTO test_nullable_column (nullable_int) VALUES (\${data.value})\`
        }
        `,
      },
    ],
    invalid: [
      {
        filename,
        options: withConnection(connections.base),
        name: "select computed column without type annotation",
        code: "const result = conn.query(sql`SELECT 1 as x`);",
        output: "const result = conn.query<{ x: number; }>(sql`SELECT 1 as x`);",
        errors: [
          { messageId: "missingTypeAnnotations", line: 1, column: 16, endLine: 1, endColumn: 26 },
        ],
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "select computed column without type annotation (with Prisma.sql)",
        code: "const result = conn.query(Prisma.sql`SELECT 1 as x`);",
        output: "const result = conn.query<{ x: number; }>(Prisma.sql`SELECT 1 as x`);",
        errors: [
          { messageId: "missingTypeAnnotations", line: 1, column: 16, endLine: 1, endColumn: 26 },
        ],
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "select column without type annotation",
        code: "const result = conn.query(sql`select id from caregiver`);",
        output: "const result = conn.query<{ id: number; }>(sql`select id from caregiver`);",
        errors: [
          { messageId: "missingTypeAnnotations", line: 1, column: 16, endLine: 1, endColumn: 26 },
        ],
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "select column with incorrect type annotation",
        code: "const result = conn.query<{ id: string; }>(sql`select id from caregiver`);",
        output: "const result = conn.query<{ id: number; }>(sql`select id from caregiver`);",
        errors: [
          { messageId: "incorrectTypeAnnotations", line: 1, column: 27, endLine: 1, endColumn: 42 },
        ],
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "select duplicate columns",
        code: "const result = conn.query(sql`select * from caregiver, agency`);",
        errors: [
          {
            messageId: "invalidQuery",
            data: {
              error: "Duplicate columns: caregiver.id, agency.id",
            },
            line: 1,
            column: 30,
            endLine: 1,
            endColumn: 36,
          },
        ],
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "select from table where int column equals to ts string arg",
        code: `
            function run(names: string[]) {
                const result = conn.query<{ name: string }>(sql\`
                    select name from agency where id = \${names}
                \`);
            }
        `,
        errors: [{ messageId: "invalidQuery", line: 4, column: 54, endLine: 4, endColumn: 55 }],
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "select statement with invalid conditional expression",
        code: `
            function run(flag: boolean) {
                const result = conn.query<{ name: string }>(sql\`
                    select name from agency where id = \${flag ? 1 : 'foo'}
                \`);
            }
        `,
        errors: [
          {
            messageId: "invalidQuery",
            data: {
              error: "Conditional expression must have the same type (true = int, false = text)",
            },
            line: 4,
            column: 58,
            endLine: 4,
            endColumn: 74,
          },
        ],
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "select statement with invalid type reference",
        code: `
            type Agency = { name: string };
            function run() {
                const result = conn.query<Agency>(sql\`
                    select id from agency where id = \${1}
                \`);
            }
        `,
        output: `
            type Agency = { name: string };
            function run() {
                const result = conn.query<{ id: number; }>(sql\`
                    select id from agency where id = \${1}
                \`);
            }
        `,
        errors: [
          {
            messageId: "incorrectTypeAnnotations",
            data: {
              expected: "{ name: string; }",
              actual: "{ id: number; }",
            },
            line: 4,
            column: 43,
            endLine: 4,
            endColumn: 49,
          },
        ],
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "select statement that should not have a type annotation",
        code: `conn.query<{}>(sql\`select\`);`,
        output: `conn.query(sql\`select\`);`,
        errors: [
          {
            messageId: "incorrectTypeAnnotations",
            data: {
              expected: "{ }",
              actual: "No type annotation",
            },
            line: 1,
            column: 12,
            endLine: 1,
            endColumn: 14,
          },
        ],
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "mixed union literals from function arg",
        code: `
          type UnionStringLiteral = "a" | 1;
          function run(union: UnionStringLiteral) {
            conn.query<{ name: string }>(sql\`select name from agency WHERE name = \${union}\`);
          }
        `,
        errors: [
          {
            messageId: "invalidQuery",
            data: {
              error: "Union types must be of the same type (found string, number)",
            },
          },
        ],
      },
      {
        filename,
        options: withConnection(connections.base),
        name: "this.[name].[operator](...) should be checked as well",
        code: `
          class X {
            run() { const result = this.conn.query(sql\`select 1 as num\`); }
          }
        `,
        output: `
          class X {
            run() { const result = this.conn.query<{ num: number; }>(sql\`select 1 as num\`); }
          }
        `,
        errors: [{ messageId: "missingTypeAnnotations" }],
      },
      {
        filename,
        options: withConnection(connections.withSkipTypeAnnotations),
        name: "invalid select with skipTypeAnnotations",
        code: "const result = conn.query(sql`SELECT idd FROM agency`);",
        errors: [
          {
            messageId: "invalidQuery",
            data: { error: 'column "idd" does not exist' },
          },
        ],
      },
      {
        name: "insert into with wrong nullable value",
        filename,
        options: withConnection(connections.withTag),
        code: `
        function insert(data: { value: string | null }) {
          sql\`INSERT INTO test_nullable_column (nullable_int) VALUES (\${data.value})\`
        }
        `,
        errors: [
          {
            messageId: "invalidQuery",
            data: {
              error: 'column "nullable_int" is of type integer but expression is of type text',
            },
          },
        ],
      },
      {
        name: "insert into with wrong nullable member expression value",
        filename,
        options: withConnection(connections.withTag),
        code: `
        function insert(data: { value: string | null }) {
          sql\`INSERT INTO test_nullable_column (nullable_int) VALUES (\${data.value})\`
        }
        `,
        errors: [
          {
            messageId: "invalidQuery",
            data: {
              error: 'column "nullable_int" is of type integer but expression is of type text',
            },
          },
        ],
      },
    ],
  });

  ruleTester.run("base with transform", rules["check-sql"], {
    valid: [
      {
        name: "transform as {type}[]",
        filename,
        options: withConnection(connections.base, {
          targets: [{ wrapper: "conn.query", transform: "{type}[]" }],
        }),
        code: "const result = conn.query<{ id: number; }[]>(sql`select id from caregiver`);",
      },
      {
        name: "transform as ['{type}[]']",
        filename,
        options: withConnection(connections.base, {
          targets: [{ wrapper: "conn.query", transform: "{type}[]" }],
        }),
        code: "const result = conn.query<{ id: number; }[]>(sql`select id from caregiver`);",
      },
      {
        name: "transform as [['middle_name', 'x_middle_name']]",
        filename,
        options: withConnection(connections.base, {
          targets: [{ wrapper: "conn.query", transform: [["middle_name", "x_middle_name"]] }],
        }),
        code: "const result = conn.query<{ x_middle_name: string | null; }>(sql`select middle_name from caregiver`);",
      },
      {
        name: "transform as ['{type}[]', ['middle_name', 'x_middle_name']]",
        filename,
        options: withConnection(connections.base, {
          targets: [
            { wrapper: "conn.query", transform: ["{type}[]", ["middle_name", "x_middle_name"]] },
          ],
        }),
        code: "const result = conn.query<{ x_middle_name: string | null; }[]>(sql`select middle_name from caregiver`);",
      },
    ],
    invalid: [],
  });

  ruleTester.run("connection with tag target", rules["check-sql"], {
    valid: [
      {
        name: "tag as sql",
        filename,
        options: withConnection(connections.withTag),
        code: "sql<{ id: number }>`select id from caregiver`",
      },
      {
        name: "tag and transform as sql (Postgres.js)",
        filename,
        options: withConnection(connections.withTag, {
          targets: [{ tag: "sql", transform: "{type}[]" }],
        }),
        code: "sql<{ id: number }[]>`select id from caregiver`",
      },
      {
        name: "sql tag inside a function",
        filename,
        options: withConnection(connections.withTag),
        code: "const result = conn.query(sql<{ id: number }>`select id from caregiver`);",
      },
    ],
    invalid: [
      {
        name: "tag without type annotations",
        filename,
        options: withConnection(connections.withTag),
        code: "sql`select id from caregiver`",
        output: "sql<{ id: number; }>`select id from caregiver`",
        errors: [
          { messageId: "missingTypeAnnotations", line: 1, column: 1, endLine: 1, endColumn: 4 },
        ],
      },
      {
        name: "tag without type annotations inside a function",
        filename,
        options: withConnection(connections.withTag),
        code: "const result = conn.query(sql`select id from caregiver`)",
        output: "const result = conn.query(sql<{ id: number; }>`select id from caregiver`)",
        errors: [
          { messageId: "missingTypeAnnotations", line: 1, column: 27, endLine: 1, endColumn: 30 },
        ],
      },
    ],
  });

  ruleTester.run("connection with overrides.types", rules["check-sql"], {
    valid: [
      {
        name: 'with { int4: "Integer" }',
        filename,
        options: withConnection(connections.withTag, {
          overrides: { types: { int4: "Integer" } },
        }),
        code: "sql<{ id: Integer }>`select id from caregiver`",
      },
      {
        name: 'with default mapping for "date"',
        filename,
        options: withConnection(connections.withTag),
        code: `
          const date = new Date();
          sql<{ id: number }>\`select id from test_date_column WHERE date_col = \${date}\`
        `,
      },
      {
        name: 'with { date: "LocalDate" }',
        filename,
        options: withConnection(connections.withTag, {
          overrides: { types: { date: "LocalDate" } },
        }),
        code: `
          class LocalDate {}
          const date = new LocalDate();
          sql<{ id: number }>\`select id from test_date_column WHERE date_col = \${date}\`
        `,
      },
      {
        name: 'with { date: { parameter: "+(Parameter<LocalDate>|LocalDate)", return: "LocalDate" } }',
        filename,
        options: withConnection(connections.withTag, {
          overrides: {
            types: {
              date: { parameter: "+(Parameter<LocalDate>|LocalDate)", return: "LocalDate" },
            },
          },
        }),
        code: `
          interface Parameter<T> { value: T; }
          class LocalDate {}
          function run(simple: LocalDate, parameterized: Parameter<LocalDate>) {
            sql<{ date_col: LocalDate }>\`select date_col from test_date_column WHERE date_col = \${simple}\`
            sql<{ date_col: LocalDate }>\`select date_col from test_date_column WHERE date_col = \${parameterized}\`
          }
        `,
      },
      {
        name: 'with { date: { parameter: { regex: "(LocalDate|Parameter<LocalDate>)" }, return: "LocalDate" } }',
        filename,
        options: withConnection(connections.withTag, {
          overrides: {
            types: {
              date: {
                parameter: { regex: "(LocalDate|Parameter<LocalDate>)" },
                return: "LocalDate",
              },
            },
          },
        }),
        code: `
          interface Parameter<T> { value: T; }
          class LocalDate {}
          function run(simple: LocalDate, parameterized: Parameter<LocalDate>) {
            sql<{ date_col: LocalDate }>\`select date_col from test_date_column WHERE date_col = \${simple}\`
            sql<{ date_col: LocalDate }>\`select date_col from test_date_column WHERE date_col = \${parameterized}\`
          }
        `,
      },
    ],
    invalid: [
      {
        name: 'with { int4: "Integer" } while { id: number }',
        filename,
        options: withConnection(connections.withTag, {
          overrides: { types: { int4: "Integer" } },
        }),
        code: "sql<{ id: number }>`select id from caregiver`",
        output: "sql<{ id: Integer; }>`select id from caregiver`",
        errors: [
          { messageId: "incorrectTypeAnnotations", line: 1, column: 5, endLine: 1, endColumn: 19 },
        ],
      },
      {
        name: 'comparing a col with `CustomDate` without { date: "CustomDate" }',
        filename,
        options: withConnection(connections.withTag, {
          overrides: {},
        }),
        code: `
          class CustomDate {}
          const date = new CustomDate();
          sql<{ id: number }>\`select id from test_date_column WHERE date_col = \${date}\`
        `,
        errors: [{ messageId: "invalidQuery", line: 4, column: 82, endLine: 4, endColumn: 86 }],
      },
      {
        filename,
        options: withConnection(connections.withGlobWrapper),
        name: "glob pattern should be checked as well (wrapper glob)",
        code: `
          class X {
            run() {
              conn.query(sql\`select 1 as num\`);
              conn.queryOne(sql\`select 1 as num\`);
              diff.query(sql\`select 1 as num\`);
            }
          }
        `,
        output: `
          class X {
            run() {
              conn.query<{ num: number; }>(sql\`select 1 as num\`);
              conn.queryOne<{ num: number; }>(sql\`select 1 as num\`);
              diff.query(sql\`select 1 as num\`);
            }
          }
        `,
        errors: [{ messageId: "missingTypeAnnotations" }, { messageId: "missingTypeAnnotations" }],
      },
      {
        filename,
        options: withConnection(connections.withRegexWrapper),
        name: "regex pattern should be checked as well (wrapper regex)",
        code: `
          class X {
            run() {
              conn.query(sql\`select 1 as num\`);
              conn.queryOne(sql\`select 1 as num\`);
              conn.queryOneDiff(sql\`select 1 as num\`);
              diff.query(sql\`select 1 as num\`);
            }
          }
        `,
        output: `
          class X {
            run() {
              conn.query<{ num: number; }>(sql\`select 1 as num\`);
              conn.queryOne<{ num: number; }>(sql\`select 1 as num\`);
              conn.queryOneDiff(sql\`select 1 as num\`);
              diff.query(sql\`select 1 as num\`);
            }
          }
        `,
        errors: [{ messageId: "missingTypeAnnotations" }, { messageId: "missingTypeAnnotations" }],
      },
      {
        filename,
        options: withConnection(connections.withGlobTag),
        name: "glob pattern should be checked as well (tag glob)",
        code: `
          class X {
            run() {
              conn1.sql\`select 1 as num\`;
              conn2.sql\`select 1 as num\`;
              conn3.sql\`select 1 as num\`;
            }
          }
        `,
        output: `
          class X {
            run() {
              conn1.sql<{ num: number; }>\`select 1 as num\`;
              conn2.sql<{ num: number; }>\`select 1 as num\`;
              conn3.sql\`select 1 as num\`;
            }
          }
        `,
        errors: [{ messageId: "missingTypeAnnotations" }, { messageId: "missingTypeAnnotations" }],
      },
      {
        filename,
        options: withConnection(connections.withRegexTag),
        name: "regex pattern should be checked as well (tag regex)",
        code: `
          class X {
            run() {
              conn1.sql\`select 1 as num\`;
              conn2.sql\`select 1 as num\`;
              conn3.sql\`select 1 as num\`;
            }
          }
        `,
        output: `
          class X {
            run() {
              conn1.sql<{ num: number; }>\`select 1 as num\`;
              conn2.sql<{ num: number; }>\`select 1 as num\`;
              conn3.sql\`select 1 as num\`;
            }
          }
        `,
        errors: [{ messageId: "missingTypeAnnotations" }, { messageId: "missingTypeAnnotations" }],
      },
      {
        filename,
        options: withConnection(connections.withMemberTag),
        name: "[x].sql should be checked as well (as member expression)",
        code: `
          class X {
            run() { const result = Db.sql\`select 1 as num\` }
          }
        `,
        output: `
          class X {
            run() { const result = Db.sql<{ num: number; }>\`select 1 as num\` }
          }
        `,
        errors: [{ messageId: "missingTypeAnnotations" }],
      },
      {
        filename,
        options: withConnection(connections.withTag),
        name: "this.[identifier] should be checked as well (as this expression)",
        code: `
          class X {
            run() { const result = this.sql\`select 1 as num\` }
          }
        `,
        output: `
          class X {
            run() { const result = this.sql<{ num: number; }>\`select 1 as num\` }
          }
        `,
        errors: [{ messageId: "missingTypeAnnotations" }],
      },
    ],
  });

  ruleTester.run("connection with fieldTransform", rules["check-sql"], {
    valid: [
      {
        name: "transform to snake case",
        filename,
        options: withConnection(connections.withTag, {
          targets: [{ tag: "sql", fieldTransform: "snake" }],
        }),
        code: 'sql<{ my_number: number }>`select 1 as "MyNumber"`',
      },
      {
        name: "transform non-table column to camel case",
        filename,
        options: withConnection(connections.withTag, {
          targets: [{ tag: "sql", fieldTransform: "camel" }],
        }),
        code: 'sql<{ myNumber: number }>`select 1 as "my_number"`',
      },
      {
        name: "transform table column to camel case",
        filename,
        options: withConnection(connections.withTag, {
          targets: [{ tag: "sql", fieldTransform: "camel" }],
        }),
        code: "sql<{ firstName: string }>`select first_name from caregiver`",
      },
      {
        name: "transform non-table column to pascal case",
        filename,
        options: withConnection(connections.withTag, {
          targets: [{ tag: "sql", fieldTransform: "pascal" }],
        }),
        code: 'sql<{ MyNumber: number }>`select 1 as "my_number"`',
      },
      {
        name: "transform table column to pascal case",
        filename,
        options: withConnection(connections.withTag, {
          targets: [{ tag: "sql", fieldTransform: "pascal" }],
        }),
        code: "sql<{ FirstName: string }>`select first_name from caregiver`",
      },
      {
        name: "transform non-table column to screaming snake case",
        filename,
        options: withConnection(connections.withTag, {
          targets: [{ tag: "sql", fieldTransform: "screaming snake" }],
        }),
        code: 'sql<{ MY_NUMBER: number }>`select 1 as "my_number"`',
      },
      {
        name: "transform table column to screaming snake case",
        filename,
        options: withConnection(connections.withTag, {
          targets: [{ tag: "sql", fieldTransform: "screaming snake" }],
        }),
        code: "sql<{ FIRST_NAME: string }>`select first_name from caregiver`",
      },
    ],
    invalid: [
      {
        name: "with camelCase while result is snake_case",
        filename,
        options: withConnection(connections.withTag, {
          targets: [{ tag: "sql", fieldTransform: "camel" }],
        }),
        code: "sql<{ first_name: string }>`select first_name from caregiver`",
        output: "sql<{ firstName: string; }>`select first_name from caregiver`",
        errors: [
          { messageId: "incorrectTypeAnnotations", line: 1, column: 5, endLine: 1, endColumn: 27 },
        ],
      },
    ],
  });
});
