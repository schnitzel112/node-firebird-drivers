import { Blob, Client, TransactionIsolation } from '../lib';

import * as fs from 'fs-extra-promise';
import * as tmp from 'temp-fs';


require('dotenv').config({ path: '../../.env' });


export function runCommonTests(client: Client) {
	function dateToString(d: Date) {
		return d && `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
	}

	function timeToString(d: Date) {
		return d && `${d.getHours()}:${d.getMinutes()}:${d.getSeconds()}.${d.getMilliseconds()}`;
	}

	function dateTimeToString(d: Date) {
		return d && `${dateToString(d)} ${timeToString(d)}`;
	}


	describe('node-firebird-driver', () => {
		const testConfig = {
			username: process.env.ISC_USER,
			password: process.env.ISC_PASSWORD,
			host: process.env.NODE_FB_TEST_HOST,
			port: process.env.NODE_FB_TEST_PORT,
			tmpDir: process.env.NODE_FB_TEST_TMP_DIR
		};

		function isLocal(): boolean {
			return testConfig.host == undefined ||
				testConfig.host == 'localhost' ||
				testConfig.host == '127.0.0.1';
		}

		function getTempFile(name: string): string {
			const database = `${testConfig.tmpDir}/${name}`;
			return (testConfig.host ?? '') +
				(testConfig.host && testConfig.port ? `/${testConfig.port}` : '') +
				(testConfig.host ? ':' : '') +
				database;
		}


		jest.setTimeout(10000);


		beforeAll(() => {
			if (isLocal() && !testConfig.tmpDir) {
				testConfig.tmpDir = tmp.mkdirSync().path.toString();

				// Important for MacOS tests with non-embedded server.
				fs.chmodSync(testConfig.tmpDir, 0o777);
			}

			const defaultOptions = {
				password: testConfig.password,
				username: testConfig.username
			};

			client.defaultCreateDatabaseOptions = {
				forcedWrite: false,
				...defaultOptions
			};

			client.defaultConnectOptions = {
				...defaultOptions
			};
		});

		afterAll(async () => {
			await client.dispose();

			if (isLocal())
				fs.rmdirSync(testConfig.tmpDir!);
		});

		describe('Client', () => {
			test('#createDatabase()', async () => {
				const attachment = await client.createDatabase(getTempFile('Client-createDatabase.fdb'));
				await attachment.dropDatabase();
			});

			test('#connect()', async () => {
				const filename = getTempFile('Client-connect.fdb');
				const attachment1 = await client.createDatabase(filename);
				const attachment2 = await client.connect(filename);

				await attachment2.disconnect();
				await attachment1.dropDatabase();
			});
		});

		describe('Attachment', () => {
			test('#startTransaction()', async () => {
				const attachment = await client.createDatabase(getTempFile('Attachment-startTransaction.fdb'));

				const isolationQuery = 'select rdb$get_context(\'SYSTEM\', \'ISOLATION_LEVEL\') from rdb$database';

				const transaction1 = await attachment.startTransaction();
				expect((await attachment.executeReturning(transaction1, isolationQuery))[0]).toBe('SNAPSHOT');
				await transaction1.commit();

				const transaction2 = await attachment.startTransaction({ isolation: TransactionIsolation.READ_COMMITTED });
				expect((await attachment.executeReturning(transaction2, isolationQuery))[0]).toBe('READ COMMITTED');
				await transaction2.commit();

				const transaction3 = await attachment.startTransaction({ isolation: TransactionIsolation.CONSISTENCY });
				expect((await attachment.executeReturning(transaction3, isolationQuery))[0]).toBe('CONSISTENCY');
				await transaction3.commit();

				await attachment.dropDatabase();
			});

			test('#prepare()', async () => {
				const attachment = await client.createDatabase(getTempFile('Attachment-prepare.fdb'));
				const transaction = await attachment.startTransaction();

				const statement = await attachment.prepare(transaction, 'create table t1 (n1 integer)');
				await statement.dispose();

				let error: Error | undefined;
				try {
					await attachment.prepare(transaction, 'create select t1 (n1 integer)');
				}
				catch (e) {
					error = e as Error;
					expect(error.message).toBe(
						'Dynamic SQL Error\n' +
						'-SQL error code = -104\n' +
						'-Token unknown - line 1, column 8\n' +
						'-select');
				}

				expect(error).toBeTruthy();

				await transaction.commit();
				await attachment.dropDatabase();
			});

			//// TODO: #executeTransaction

			test('#execute()', async () => {
				const attachment = await client.createDatabase(getTempFile('Attachment-execute.fdb'));
				const transaction = await attachment.startTransaction();

				await attachment.execute(transaction, 'create table t1 (n1 integer)');
				await transaction.commitRetaining();

				await attachment.execute(transaction, 'insert into t1 (n1) values (1)');

				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#executeQuery()', async () => {
				const attachment = await client.createDatabase(getTempFile('Attachment-executeQuery.fdb'));
				const transaction = await attachment.startTransaction();

				await attachment.execute(transaction, 'create table t1 (n1 integer)');
				await transaction.commitRetaining();

				const resultSet = await attachment.executeQuery(transaction, 'select n1 from t1');
				await resultSet.close();

				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#executeReturning()', async () => {
				const attachment = await client.createDatabase(getTempFile('Attachment-executeReturning.fdb'));
				const transaction = await attachment.startTransaction();

				await attachment.execute(transaction, 'create table t1 (n1 integer)');
				await transaction.commitRetaining();

				const result = await attachment.executeReturning(transaction, 'insert into t1 values (11) returning n1');
				expect(result.length).toBe(1);
				expect(result[0]).toBe(11);

				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#executeReturningAsObject()', async () => {
				const attachment = await client.createDatabase(getTempFile('Attachment-executeReturningAsObject.fdb'));
				const transaction = await attachment.startTransaction();

				await attachment.execute(transaction, 'create table t1 (n1 integer)');
				await transaction.commitRetaining();

				const output = await attachment.executeReturningAsObject<{ N1: number }>(transaction,
					'insert into t1 values (11) returning n1');
				expect(output.N1).toBe(11);

				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#queueEvents()', async () => {
				const attachment = await client.createDatabase(getTempFile('Attachment-queueEvents.fdb'));

				const eventNames: [string, number][] = [
					['EVENT1', 16],
					['EVENT2', 8]
				];

				const eventsObj = eventNames.map(([name, expected]) => {
					let resolver: () => void = undefined!;

					const obj = {
						name,
						expected,
						count: 0,
						promise: new Promise<void>(resolve => resolver = resolve)
					};

					return { ...obj, resolver };
				});
				const eventsMap = new Map(eventsObj.map(ev => [ev.name, ev]));

				const eventHandler = async (counters: [string, number][]) => {
					counters.forEach(([name, count]) => {
						const obj = eventsMap.get(name)!;
						const newCount = obj.count + count;
						obj.count = newCount;

						if (newCount >= obj.expected)
							obj.resolver();
					});

					if (Array.from(eventsMap.values()).every(obj => obj.count >= obj.expected)) {
						if (events) {
							await events.cancel();
							events = null!;
						}
					}
				};

				let events = await attachment.queueEvents(Array.from(eventsMap.keys()), eventHandler);

				const transaction = await attachment.startTransaction();
				try {
					// Iterate more times than the neccessary so that
					// eventHandler may have a chance to cancel the events.
					for (let i = 0; i < 20; ++i) {
						await attachment.execute(transaction, `
							execute block as
							begin
							    post_event 'EVENT1';
							    post_event 'EVENT1';
							    post_event 'EVENT2';
							    post_event 'EVENT3';
							end
						`);

						// Commit retaining to test internal event rescheduling
						// after each handler dispatch.
						await transaction.commitRetaining();
					}
				}
				finally {
					await transaction.commit();
				}

				await Promise.all(eventsObj.map(ev => ev.promise));

				if (events)
					await events.cancel();

				eventsObj.forEach(ev => expect(ev.count).toBeGreaterThanOrEqual(ev.expected));

				await attachment.dropDatabase();
			});
		});

		describe('Transaction', () => {
			test('#commit()', async () => {
				const attachment = await client.createDatabase(getTempFile('Transaction-commit.fdb'));
				const transaction = await attachment.startTransaction();
				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#commitRetaining()', async () => {
				const attachment = await client.createDatabase(getTempFile('Transaction-commitRetaining.fdb'));
				const transaction = await attachment.startTransaction();
				await transaction.commitRetaining();
				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#rollback()', async () => {
				const attachment = await client.createDatabase(getTempFile('Transaction-rollback.fdb'));
				const transaction = await attachment.startTransaction();
				await transaction.rollback();
				await attachment.dropDatabase();
			});

			test('#rollbackRetaining()', async () => {
				const attachment = await client.createDatabase(getTempFile('Transaction-rollbackRetaining.fdb'));
				const transaction = await attachment.startTransaction();
				await transaction.rollbackRetaining();
				await transaction.rollback();
				await attachment.dropDatabase();
			});

			test('transaction left opened', async () => {
				const attachment = await client.createDatabase(getTempFile('Transaction-left-opened.fdb'));
				await attachment.startTransaction();
				await attachment.dropDatabase();
			});
		});

		describe('Statement', () => {
			test('#execute()', async () => {
				const attachment = await client.createDatabase(getTempFile('Statement-execute.fdb'));
				const transaction = await attachment.startTransaction();

				const statement1 = await attachment.prepare(transaction, 'create table t1 (n1 integer)');
				await statement1.execute(transaction);
				await statement1.dispose();
				await transaction.commitRetaining();

				const statement2 = await attachment.prepare(transaction, 'insert into t1 (n1) values (?)');
				await statement2.execute(transaction, [1]);
				await statement2.execute(transaction, [null]);
				await statement2.execute(transaction, [10]);
				await statement2.execute(transaction, [100]);
				await statement2.dispose();

				const rs = await attachment.executeQuery(transaction,
					`select sum(n1) || ', ' || count(n1) || ', ' || count(*) ret from t1`);
				const ret = await rs.fetchAsObject<{ RET: string }>();
				await rs.close();

				expect(ret[0].RET).toStrictEqual('111, 3, 4');

				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#executeQuery()', async () => {
				const attachment = await client.createDatabase(getTempFile('Statement-executeQuery.fdb'));
				const transaction = await attachment.startTransaction();

				const statement1 = await attachment.prepare(transaction, 'create table t1 (n1 integer)');
				await statement1.execute(transaction);
				await statement1.dispose();
				await transaction.commitRetaining();

				const statement2 = await attachment.prepare(transaction, 'select n1 from t1');
				const resultSet2 = await statement2.executeQuery(transaction);
				await resultSet2.close();
				await statement2.dispose();

				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#executeReturning()', async () => {
				const attachment = await client.createDatabase(getTempFile('Attachment-executeReturning.fdb'));
				const transaction = await attachment.startTransaction();

				await attachment.execute(transaction, 'create table t1 (n1 integer)');
				await transaction.commitRetaining();

				const statement = await attachment.prepare(transaction, 'insert into t1 values (11) returning n1, n1 * 2');

				const result = await statement.executeReturning(transaction);
				expect(result.length).toBe(2);
				expect(result[0]).toBe(11);
				expect(result[1]).toBe(11 * 2);

				await statement.dispose();

				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#columnLabels()', async () => {
				const attachment = await client.createDatabase(getTempFile('Statement-columnLabels.fdb'));
				const transaction = await attachment.startTransaction();

				const statement1 = await attachment.prepare(transaction, 'create table t1 (n1 integer)');
				expect(await statement1.columnLabels).toStrictEqual([]);
				await statement1.execute(transaction);
				await statement1.dispose();
				await transaction.commitRetaining();

				const statement2 = await attachment.prepare(transaction, 'select n1, n1 x from t1');
				expect(await statement2.columnLabels).toStrictEqual(['N1', 'X']);
				await statement2.dispose();

				await transaction.commit();
				await attachment.dropDatabase();
			});
		});

		describe('ResultSet', () => {
			test('#fetch()', async () => {
				const attachment = await client.createDatabase(getTempFile('ResultSet-fetch.fdb'));
				let transaction = await attachment.startTransaction();

				const blobBuffer = Buffer.alloc(11, '12345678á9');

				const fields = [
					{ name: 'x_short', type: 'numeric(2)', valToStr: (v: any) => v },
					{ name: 'x_int', type: 'integer', valToStr: (v: any) => v },
					{ name: 'x_int_scale', type: 'numeric(5, 2)', valToStr: (v: any) => v },
					{ name: 'x_bigint', type: 'bigint', valToStr: (v: any) => v },
					{ name: 'x_bigint_scale', type: 'numeric(15, 2)', valToStr: (v: any) => v },
					{ name: 'x_int128', type: 'int128', valToStr: (v: any) => v },
					{ name: 'x_int128_scale', type: 'numeric(20, 2)', valToStr: (v: any) => v },
					{ name: 'x_dec16', type: 'decfloat(16)', valToStr: (v: any) => v },
					{ name: 'x_dec34', type: 'decfloat(34)', valToStr: (v: any) => v },
					{ name: 'x_double', type: 'double precision', valToStr: (v: any) => v },
					{ name: 'x_date', type: 'date', valToStr: (v: any) => `date '${dateToString(v)}'` },
					{ name: 'x_time', type: 'time', valToStr: (v: any) => `time '${timeToString(v)}'` },
					{ name: 'x_timestamp', type: 'timestamp', valToStr: (v: any) => `timestamp '${dateTimeToString(v)}'` },
					{ name: 'x_boolean', type: 'boolean', valToStr: (v: any) => v },
					{ name: 'x_varchar', type: 'varchar(10) character set utf8', valToStr: (v: any) => `'${v}'` },
					{ name: 'x_char', type: 'char(10) character set utf8', valToStr: (v: any) => `'${v}'` },
					{ name: 'x_blob1', type: 'blob', valToStr: (v: Buffer) => `'${v.toString()}'` },
					{ name: 'x_blob2', type: 'blob', valToStr: () => `'${blobBuffer.toString()}'` }
				];

				const statement1 = await attachment.prepare(transaction,
					`create table t1 (${fields.map(f => `${f.name} ${f.type}`).join(', ')})`);
				await statement1.execute(transaction);
				await statement1.dispose();
				await transaction.commitRetaining();

				const recordCount = 5;
				const now = new Date();
				let parameters: any[];

				{	// scope
					const statement2a = await attachment.prepare(transaction,
						`insert into t1 (${fields.map(f => f.name).join(', ')}) values (${fields.map(() => '?').join(', ')})`);

					// Test execution in a new transaction, after the one used in prepare was committed.
					await transaction.commit();
					transaction = await attachment.startTransaction();

					const blob = await attachment.createBlob(transaction);
					await blob.write(blobBuffer);
					await blob.close();

					parameters = [
						-1,
						-2,
						-3.45,
						-2,
						-3.45,
						'-45699999999999999999999999999999999876',
						'-45699999999999999999999999999999999.87',
						'-456999999999876',
						'-456999999999999999999999999999.87',
						-4.567,
						new Date(2017, 3 - 1, 26),
						new Date(now.getFullYear(), now.getMonth(), now.getDate(), 11, 56, 32, 123),
						new Date(2017, 3 - 1, 26, 11, 56, 32, 123),
						true,
						'123áé4567',
						'123áé4567',
						blobBuffer,
						blob
					];

					for (let i = 0; i < recordCount; ++i)
						await statement2a.execute(transaction, parameters);
					await statement2a.dispose();
				}

				{	// scope
					const statement2b = await attachment.prepare(transaction,
						`insert into t1 (${fields.map(f => f.name).join(', ')}) ` +
						`values (${parameters.map((val, index) => fields[index].valToStr(val)).join(', ')})`);

					for (let i = 0; i < recordCount; ++i)
						await statement2b.execute(transaction);
					await statement2b.dispose();
				}

				await transaction.commitRetaining();

				const statement3 = await attachment.prepare(transaction,
					`select x_short,
							x_int,
							x_int_scale,
							x_bigint,
							x_bigint_scale,
							x_int128,
							x_int128_scale,
							x_dec16,
							x_dec34,
							x_double,
							x_date,
							x_time,
							x_timestamp,
							x_boolean,
							x_varchar,
							char_length(x_varchar),
							octet_length(x_varchar),
							x_char,
							char_length(x_char),
							octet_length(x_char),
							null,
							x_char || null,
							x_blob1,
							x_blob2
					from t1`);
				const resultSet3 = await statement3.executeQuery(transaction);

				const data = await resultSet3.fetch();
				expect(data.length).toBe(recordCount * 2);

				for (const columns of data) {
					let n = 0;
					expect(columns[n++]).toBe(-1);
					expect(columns[n++]).toBe(-2);
					expect(columns[n++]).toBe(-3.45);
					expect(columns[n++]).toBe(-2);
					expect(columns[n++]).toBe(-3.45);
					expect(columns[n++]).toBe('-45699999999999999999999999999999999876');
					expect(columns[n++]).toBe('-45699999999999999999999999999999999.87');
					expect(columns[n++]).toBe('-456999999999876');
					expect(columns[n++]).toBe('-456999999999999999999999999999.87');
					expect(columns[n++]).toBe(-4.567);
					expect(dateTimeToString(columns[n++])).toBe('2017-3-26 0:0:0.0');
					expect(timeToString(columns[n++])).toBe('11:56:32.123');
					expect(dateTimeToString(columns[n++])).toBe('2017-3-26 11:56:32.123');
					expect(columns[n++]).toBe(true);
					expect(columns[n++]).toBe('123áé4567');
					expect(columns[n++]).toBe(9);
					expect(columns[n++]).toBe(11);
					expect(columns[n++]).toBe('123áé4567 ');
					expect(columns[n++]).toBe(10);
					expect(columns[n++]).toBe(12);
					expect(columns[n++]).toBeNull();
					expect(columns[n++]).toBeNull();

					for (const i = n + 2; n < i; ++n) {
						const blob = columns[n] as Blob;
						const blobStream = await attachment.openBlob(transaction, blob);
						const buffer = Buffer.alloc(await blobStream.length);
						expect(await blobStream.read(buffer)).toBe(buffer.length);
						expect(await blobStream.read(buffer)).toBe(-1);

						await blobStream.close();

						expect(buffer.toString()).toBe('12345678á9');
					}

					expect(columns.length).toBe(n);
				}

				expect((await resultSet3.fetch()).length).toBe(0);
				expect((await resultSet3.fetch()).length).toBe(0);

				await resultSet3.close();
				await statement3.dispose();

				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#fetchAsObject()', async () => {
				const attachment = await client.createDatabase(getTempFile('ResultSet-fetchAsObject.fdb'));
				const transaction = await attachment.startTransaction();
				const resultSet = await attachment.executeQuery(transaction, 'select 1 as a, 2 as b from rdb$database');
				const output = await resultSet.fetchAsObject<{ A: number; B: number }>();
				expect(output[0].A).toBe(1);
				expect(output[0].B).toBe(2);
				await resultSet.close();

				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#fetch() with fetchSize', async () => {
				const attachment = await client.createDatabase(getTempFile('ResultSet-fetch-with-fetchSize.fdb'));
				const transaction = await attachment.startTransaction();

				await attachment.execute(transaction, 'create table t1 (n1 integer)');
				await transaction.commitRetaining();

				await attachment.execute(transaction, `
					execute block
					as
						declare n integer = 0;
					begin
						while (n < 50) do
						begin
							insert into t1 values (:n);
							n = n + 1;
						end
					end
				`);

				const rs = await attachment.executeQuery(transaction, 'select n1 from t1 order by n1');
				rs.defaultFetchOptions = { fetchSize: 5 };

				expect((await rs.fetch()).length).toBe(5);
				expect((await rs.fetch({ fetchSize: 2 })).length).toBe(2);
				expect((await rs.fetch()).length).toBe(5);
				expect((await rs.fetch({ fetchSize: 36 })).length).toBe(36);
				expect((await rs.fetch()).length).toBe(2);
				expect((await rs.fetch()).length).toBe(0);

				await rs.close();

				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#fetch() with fetchSize and exception', async () => {
				const attachment = await client.createDatabase(getTempFile('ResultSet-fetch-with-fetchSize.fdb'));
				const transaction = await attachment.startTransaction();

				await attachment.execute(transaction, 'create exception e1 \'e1\'');
				await transaction.commitRetaining();

				const rs = await attachment.executeQuery(transaction, `
					execute block returns (n integer)
					as
					begin
						n = 1;
						suspend;
						n = 2;
						suspend;
						exception e1;
						n = 3;
						suspend;
					end
				`);
				rs.defaultFetchOptions = { fetchSize: 5 };

				expect((await rs.fetch()).length).toBe(2);
				expect(rs.fetch()).rejects.toBeTruthy();

				await rs.close();

				await transaction.commit();
				await attachment.dropDatabase();
			});

			test('#fetch() with large blob', async () => {
				const attachment = await client.createDatabase(getTempFile('ResultSet-fetch-with-large-blob.fdb'));
				let transaction = await attachment.startTransaction();
				await attachment.execute(transaction, `create table t1 (x_blob blob)`);

				await transaction.commit();
				transaction = await attachment.startTransaction();
				const buffer = Buffer.from('123'.repeat(60000));

				await attachment.execute(transaction, `insert into t1 (x_blob) values (?)`, [buffer]);

				await transaction.commit();
				transaction = await attachment.startTransaction();

				const resultSet = await attachment.executeQuery(transaction, `select x_blob from t1`);
				const result = await resultSet.fetch();
				const readStream = await attachment.openBlob(transaction, result[0][0]);

				const blobLength = await readStream.length;
				const resultBuffer = Buffer.alloc(blobLength);

				let size = 0;
				let n: number;
				while (size < blobLength && (n = await readStream.read(resultBuffer.slice(size))) > 0)
					size += n;

				await readStream.close();
				expect(resultBuffer.toString().length).toEqual(buffer.toString().length);
				expect(resultBuffer.toString()).toEqual(buffer.toString());

				await resultSet.close();
				await transaction.commit();
				await attachment.dropDatabase();
			});
		});
	});
}
