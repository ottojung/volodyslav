const fs = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');
const temporary = require('./temporary');
const { getMockedRootCapabilities } = require('./mockCapabilities');
const createTestRepo = require('./custom_test_setup/create_test_repo');
const defaultBranch = require('../src/gitstore/default_branch');

// Mock environment module before requiring working_repository
jest.mock('../src/environment');

let environment;
let workingRepository;
let capabilities;

describe('working_repository module', () => {
  beforeEach(async () => {
    temporary.beforeEach();
    jest.resetModules();
    // prepare a bare repo
    const { gitDir } = await createTestRepo(defaultBranch);
    // mock environment
    environment = require('../src/environment');
    environment.workingDirectory = () => temporary.input();
    environment.eventLogRepository = () => gitDir;
    // import module under test
    workingRepository = require('../src/gitstore/working_repository');
    capabilities = getMockedRootCapabilities();
  });

  afterEach(() => {
    temporary.afterEach();
  });

  test('getRepository clones a fresh repository', async () => {
    const localRepo = await workingRepository.getRepository(capabilities);
    // localRepo directory should exist
    const stat = await fs.stat(localRepo);
    expect(stat.isDirectory()).toBe(true);
    // should contain the committed test.txt file
    const files = await fs.readdir(localRepo);
    expect(files).toEqual(expect.arrayContaining(['test.txt', 'data.json']));
  });

  test('synchronize pulls new changes from remote', async () => {
    // initial clone
    const localRepo = await workingRepository.getRepository(capabilities);
    // prepare a separate working clone to add a commit and push
    const clone2 = path.join(temporary.input(), 'wt2');
    await fs.mkdir(clone2, { recursive: true });
    execFileSync('git', ['clone', '--branch', defaultBranch, environment.eventLogRepository(), clone2]);
    // modify file and push
    const testFilePath = path.join(clone2, 'test.txt');
    await fs.writeFile(testFilePath, 'updated content');
    execFileSync('git', ['-C', clone2, 'add', 'test.txt']);
    execFileSync('git', ['-C', clone2, 'config', 'user.name', 'Test User']);
    execFileSync('git', ['-C', clone2, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', clone2, 'commit', '-m', 'Update test']);
    execFileSync('git', ['-C', clone2, 'push', 'origin', defaultBranch]);

    // run synchronize on our module
    await workingRepository.synchronize(capabilities);
    // verify pull: localRepo/test.txt has updated content
    const content = await fs.readFile(path.join(localRepo, 'test.txt'), 'utf8');
    expect(content.trim()).toBe('updated content');
  });

  test('getRepository returns existing repository without re-cloning', async () => {
    const localRepo1 = await workingRepository.getRepository(capabilities);
    // write a marker file into localRepo
    const marker = 'marker.txt';
    const markerPath = path.join(localRepo1, marker);
    await fs.writeFile(markerPath, 'x');
    // second call
    const localRepo2 = await workingRepository.getRepository(capabilities);
    expect(localRepo2).toBe(localRepo1);
    // marker should still exist
    const content = await fs.readFile(markerPath, 'utf8');
    expect(content).toBe('x');
  });

  test('getRepository propagates errors as WorkingRepositoryError', async () => {
    // make workingDirectory unwritable or remove clone dir to trigger ENOENT
    // here we set workingDirectory to a non-existent base
    const brokenBase = path.join(temporary.input(), 'nonexistent');
    environment.workingDirectory = () => brokenBase;
    // fresh import to pick up new workingDirectory
    workingRepository = require('../src/gitstore/working_repository');
    await expect(
      workingRepository.getRepository(capabilities)
    ).rejects.toMatchObject({
      name: 'Error', // custom error has no name override
      repositoryPath: brokenBase + '/working-git-repository'
    });
  });
});
