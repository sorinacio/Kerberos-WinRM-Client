import { environments } from '../config/env.config';
import winrm from 'nodejs-winrm';

export class WindowsManager {
  private host: string;
  private username: string;
  private password: string;
  private testNetwork: string;

  constructor(instance: keyof typeof environments) {
    const config = environments[instance];
    if (!config) {
      throw new Error(`Instance "${instance}" not found in env.config.ts`);
    }
    this.host = config.baseURL;
    this.username = config.username;
    this.password = config.password;
    this.testNetwork = config.vmTestNetwork;
    if (!this.testNetwork) {
      throw new Error(`"vmTestNetwork" not specified in env.config for instance "${instance}"`);
    }
  }

  public async disableNetworkAdapter(): Promise<void> {
    const command = `Disable-NetAdapter -Name '${this.testNetwork}' -Confirm:$false`;
    await this.runWinRMCommand(command);
  }

  public async enableNetworkAdapter(): Promise<void> {
    const command = `Enable-NetAdapter -Name '${this.testNetwork}' -Confirm:$false`;
    await this.runWinRMCommand(command);
  }

  private async runWinRMCommand(command: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const options = {
        host: this.host,
        username: this.username,
        password: this.password,
        port: 5985,
      };
      winrm.runCommand(command, options.host, options.port, options.username, options.password, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
