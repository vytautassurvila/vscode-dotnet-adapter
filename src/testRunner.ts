import * as vscode from 'vscode';

// vscode-test-adapter imports
import {
	TestRunStartedEvent,
	TestRunFinishedEvent,
	TestSuiteEvent,
	TestEvent
} from 'vscode-test-adapter-api';

import { Log } from 'vscode-test-adapter-util';

import { DebugController } from "./debugController"

import { TestResultsFile } from "./testResultsFile";
import { TestDiscovery } from './testDiscovery';
import Command from './Command';
import { getUid } from './utilities';
import { ConfigManager } from './configManager';


export class TestRunner {
	private readonly configManager: ConfigManager;

	private Runningtest: Command | undefined;

    constructor(
        private readonly workspace: vscode.WorkspaceFolder,
		private readonly outputchannel: vscode.OutputChannel,
		private readonly log: Log,
        private readonly testDiscovery: TestDiscovery,
        private readonly testStatesEmitter: vscode.EventEmitter<TestRunStartedEvent |
	    TestRunFinishedEvent | TestSuiteEvent | TestEvent>
	) {
		this.configManager = new ConfigManager(this.workspace, this.log);
	}

    public async Run(tests: string[]): Promise<void> {
        this.InnerRun(tests, false);
    }

    public async Debug(tests: string[]): Promise<void> {
        this.InnerRun(tests, true);
    }

    public Cancel(): void {
        //kill the child process for the current test run (if there is any)
		if (this.Runningtest) {
			this.Runningtest.childProcess.kill();
			this.Runningtest = undefined;
		}
    }

    private async InnerRun(tests: string[], isDebug: boolean): Promise<void> {
		try {
            if (this.Runningtest) return;
            this.log.info(`Running tests ${JSON.stringify(tests)}`);

            if (tests[0] == 'root') {
                let nodeContext = this.testDiscovery.GetNode(tests[0]) as DerivitecSuiteContext;
                tests = nodeContext?.node.children.map(i => i.id);
            }

            for (const id of tests) {
                let nodeContext = this.testDiscovery.GetNode(id);
                if (nodeContext) {
                    await this.RunTest(nodeContext.node, isDebug);
                }
            }
        } catch (error) {
            this.log.error(error);
        }
    }

	private async RunTest(node: DerivitecTestSuiteInfo | DerivitecTestInfo, isDebug: boolean): Promise<void> {
		const debugController = new DebugController(this.workspace, this.Runningtest, this.log);

		const testOutputFile = `${getUid()}.trx`;

		const envVars = this.configManager.get('runEnvVars');
		const args: string[] = [];
		args.push('vstest');
		args.push(node.sourceDll);
		if (!node.sourceDll.endsWith(`${node.id}.dll`))
			args.push(`--Tests:${node.id}`);
		args.push('--Parallel');
		args.push(`--logger:trx;LogFileName=${testOutputFile}`);
		this.TriggerRunningEvents(node);
		this.Runningtest = new Command(
			'dotnet',
			args,
			{
				cwd: this.workspace.uri.fsPath,
				env: {
					"VSTEST_HOST_DEBUG": isDebug ? "1" : "0",
					...envVars,
				}
			}
		);
		this.Runningtest.onStdOut(async data => {
			if (isDebug) {
				await debugController.onData(data);
			}
			this.outputchannel.append(data.toString());
		});
		this.Runningtest.onStdErr(data => {
			this.outputchannel.append(data.toString());
		});
		await this.Runningtest.exitCode;
		this.Runningtest = undefined;
		await this.ParseTestResults(node, testOutputFile);
		this.MarkSuiteComplete(node);
	}

	private MarkSuiteComplete(node: DerivitecTestSuiteInfo | DerivitecTestInfo) {
		if(node.type == 'test') return;
		for (let child of node.children)
			this.MarkSuiteComplete(child as (DerivitecTestSuiteInfo | DerivitecTestInfo));
		const nodeContext = this.testDiscovery.GetNode(node.id) as DerivitecSuiteContext;
		if (!nodeContext) return;
		nodeContext.event = {
			type: 'suite', suite: node.id, state: 'completed'
		}

		this.testStatesEmitter.fire(<TestSuiteEvent>nodeContext.event);
    }

    private TriggerRunningEvents(node: DerivitecTestSuiteInfo | DerivitecTestInfo) {
		const nodeContext = this.testDiscovery.GetNode(node.id);
		if (!nodeContext) return;
		if (node.type == 'suite') {
			nodeContext.event = {
				type: 'suite', suite: node.id, state: 'running'
			}
			this.testStatesEmitter.fire(<TestSuiteEvent>nodeContext.event);
			for (let child of node.children)
				this.TriggerRunningEvents(child as (DerivitecTestSuiteInfo | DerivitecTestInfo));

		} else {
			nodeContext.event = {
				type: 'test', test: node.id, state: 'running'
			}
			this.testStatesEmitter.fire(<TestEvent>nodeContext.event);
		}
	}


	private async ParseTestResults(node: DerivitecTestSuiteInfo | DerivitecTestInfo, testOutputFile: string): Promise<void> {
		const testResultConverter = new TestResultsFile();
		const results = await testResultConverter.parseResults(testOutputFile);
		const testContexts = this.GetTestsFromNode(node);
		const testContextsMap = new Map(testContexts.map(i => [i.node.id, i]));
		for(const result of results) {
			const testContext = testContextsMap.get(result.fullName);
		  if (testContext) {
				switch (result.outcome) {
					case "Error":
						testContext.event = {
							type: "test",
							test: testContext.node.id,
							state: "errored",
							message: result.stackTrace,
						}
						break;
					case "Failed":
						testContext.event = {
							type: "test",
							test: testContext.node.id,
							state: "failed",
							message: result.message,
						}
						break;
					case "Passed":
						testContext.event = {
							type: "test",
							test: testContext.node.id,
							state: "passed",
							message: result.message,
						}
						break;
					case "NotExecuted":
						testContext.event = {
							type: "test",
							test: testContext.node.id,
							state: "skipped"
						}
						break;
					default:
						break;
				}
				this.testStatesEmitter.fire(<TestEvent>testContext.event);
			}
		}
	}
	private GetTestsFromNode(node:DerivitecTestSuiteInfo | DerivitecTestInfo) {
		const testContexts: DerivitecTestContext[] = [];
		if (node.type == "suite") {
			for (const child of node.children ) {
				const innerContexts = this.GetTestsFromNode(child as (DerivitecTestSuiteInfo | DerivitecTestInfo));
				for (const innerContext of innerContexts) {
					testContexts.push(innerContext);
				}
			}
		} else {
			const context = this.testDiscovery.GetNode(node.id);
			testContexts.push(context as DerivitecTestContext);
		}
		return testContexts;
	}
}