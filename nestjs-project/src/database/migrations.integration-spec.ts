import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1791138298352 } from './migrations/1791138298352-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

// Enum types created by the migrations. Other suites share this DB and can leave
// them behind (TypeORM creates them alongside the entity tables), so they must be
// dropped together with the tables or `CREATE TYPE` fails with "already exists".
const MANAGED_TYPES = ['verification_tokens_type_enum'];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1791138298352,
        ],
      },
    );

    await dataSource.initialize();

    // A single statement: concurrent CASCADE drops over FK-linked tables
    // (videos → channels → users) lock each other and deadlock.
    const tables = [...MANAGED_TABLES, 'migrations']
      .map((table) => `"${table}"`)
      .join(', ');
    await dataSource.query(`DROP TABLE IF EXISTS ${tables} CASCADE`);
    const types = MANAGED_TYPES.map((type) => `"${type}"`).join(', ');
    await dataSource.query(`DROP TYPE IF EXISTS ${types} CASCADE`);
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving the videos table missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  async function existingTables(tables: string[]): Promise<string[]> {
    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [tables],
    );
    return result.map((r) => r.table_name);
  }

  it('should apply all migrations and create all managed tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);
    expect(await existingTables(MANAGED_TABLES)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove only the videos table', async () => {
    await dataSource.undoLastMigration();

    expect(await existingTables(MANAGED_TABLES)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
  });
});
