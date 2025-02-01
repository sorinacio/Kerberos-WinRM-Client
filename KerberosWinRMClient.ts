// KerberosWinRMClient.ts
import * as http from 'http';
import { parseString } from 'xml2js';
import { initializeClient } from 'kerberos';

/**
 * Options for creating a Kerberos WinRM client.
 */
export interface KerberosWinRMOptions {
  host: string;                   // e.g. "winrm.example.com"
  port: number;                   // 5985 for HTTP, or 5986 for HTTPS
  servicePrincipalName: string;   // e.g. "HTTP/winrm.example.com"
  useSSL?: boolean;               // set to true if using HTTPS
  path?: string;                  // usually "/wsman"
  timeout?: number;               // optional request timeout in milliseconds
}

/**
 * Main class for Kerberos-based WinRM operations.
 */
export class KerberosWinRMClient {
  private readonly host: string;
  private readonly port: number;
  private readonly spn: string;
  private readonly useSSL: boolean;
  private readonly path: string;
  private readonly timeout: number;

  // Keep track of the active shellId if created
  private shellId: string | null = null;

  constructor(options: KerberosWinRMOptions) {
    this.host = options.host;
    this.port = options.port;
    this.spn = options.servicePrincipalName;
    this.useSSL = options.useSSL || false;
    this.path = options.path || '/wsman';
    this.timeout = options.timeout || 60000;
  }

  /**
   * Public method to create a WinRM shell.
   */
  public async createShell(): Promise<string> {
    if (this.shellId) {
      // Shell already created
      return this.shellId;
    }

    const envelope = this.buildCreateShellEnvelope();
    const initialToken = await this.getInitialKerberosToken();

    // Send the SOAP request to create a shell
    const response = await this.sendWinRMRequest(envelope, initialToken);
    // Extract shellId from the SOAP response
    const shellId = this.extractShellId(response);

    if (!shellId) {
      throw new Error('Failed to parse shellId from CreateShell response.');
    }

    this.shellId = shellId;
    return this.shellId;
  }

  /**
   * Public method to execute a command in the existing shell.
   */
  public async executeCommand(command: string): Promise<string> {
    if (!this.shellId) {
      throw new Error('No shellId. Call createShell() first.');
    }

    const envelope = this.buildExecuteCommandEnvelope(this.shellId, command);
    const initialToken = await this.getInitialKerberosToken();

    // Send the SOAP request
    const response = await this.sendWinRMRequest(envelope, initialToken);
    // Extract commandId from the response
    const commandId = this.extractCommandId(response);

    if (!commandId) {
      throw new Error('Failed to parse commandId from ExecuteCommand response.');
    }

    return commandId;
  }

  /**
   * Public method to receive output from a previously executed command.
   */
  public async receiveOutput(commandId: string): Promise<string> {
    if (!this.shellId) {
      throw new Error('No shellId. Call createShell() first.');
    }

    const envelope = this.buildReceiveEnvelope(this.shellId, commandId);
    const initialToken = await this.getInitialKerberosToken();

    const response = await this.sendWinRMRequest(envelope, initialToken);
    // Extract output from the response (stdout + stderr, etc.)
    const output = this.extractCommandOutput(response);
    return output;
  }

  /**
   * Public method to delete the shell.
   */
  public async deleteShell(): Promise<void> {
    if (!this.shellId) {
      // Nothing to delete
      return;
    }

    const envelope = this.buildDeleteShellEnvelope(this.shellId);
    const initialToken = await this.getInitialKerberosToken();

    await this.sendWinRMRequest(envelope, initialToken);
    this.shellId = null;
  }

  /**
   * Obtain the initial Kerberos token for our SPN (service principal name).
   * This is the first "step" in a multi-step negotiation if the server challenges us.
   */
  private getInitialKerberosToken(): Promise<string> {
    return new Promise((resolve, reject) => {
      initializeClient(this.spn, {}, (err, client) => {
        if (err) return reject(err);

        // Pass an empty string for the initial step
        client.step('', (stepErr, token) => {
          if (stepErr) return reject(stepErr);
          resolve(token);
        });
      });
    });
  }

  /**
   * Send a SOAP envelope to WinRM with 'Negotiate <token>'.
   * Handles 401 with a 'WWW-Authenticate: Negotiate <challenge>' by doing another Kerberos step.
   */
  private async sendWinRMRequest(soapEnvelope: string, negotiateToken: string): Promise<any> {
    const protocol = this.useSSL ? 'https:' : 'http:';
    const authHeader = `Negotiate ${negotiateToken}`;

    const requestOptions: http.RequestOptions = {
      method: 'POST',
      host: this.host,
      port: this.port,
      path: this.path,
      headers: {
        'Content-Type': 'application/soap+xml;charset=UTF-8',
        'Content-Length': Buffer.byteLength(soapEnvelope),
        'Authorization': authHeader,
      },
    };

    return new Promise((resolve, reject) => {
      const req = (this.useSSL ? require('https') : require('http')).request(requestOptions, (res: http.IncomingMessage) => {
        let responseData = '';

        // If we got a 401, attempt next negotiation step
        if (res.statusCode === 401) {
          const negotiateHeader = res.headers['www-authenticate'];
          if (negotiateHeader && typeof negotiateHeader === 'string' && negotiateHeader.startsWith('Negotiate ')) {
            const challenge = negotiateHeader.substring('Negotiate '.length);
            // Perform next Kerberos step
            this.doKerberosStep(challenge)
              .then((newToken) => {
                // Retry with newToken
                return this.sendWinRMRequest(soapEnvelope, newToken);
              })
              .then(resolve)
              .catch(reject);
          } else {
            reject(new Error('401 Unauthorized, but no Negotiate challenge found.'));
          }
          return;
        }

        // Non-2xx and non-401
        if (res.statusCode && (res.statusCode < 200 || res.statusCode > 299) && res.statusCode !== 401) {
          reject(new Error(`Request failed with status code ${res.statusCode}`));
          return;
        }

        res.on('data', (chunk) => (responseData += chunk));
        res.on('end', () => {
          this.parseXml(responseData)
            .then(resolve)
            .catch(reject);
        });
      });

      req.on('error', (e) => reject(e));
      req.setTimeout(this.timeout, () => {
        req.abort();
        reject(new Error('WinRM request timed out.'));
      });

      req.write(soapEnvelope);
      req.end();
    });
  }

  /**
   * Perform the next step of Kerberos authentication after receiving a challenge.
   */
  private doKerberosStep(challenge: string): Promise<string> {
    return new Promise((resolve, reject) => {
      initializeClient(this.spn, {}, (err, client) => {
        if (err) return reject(err);

        client.step(challenge, (stepErr, token) => {
          if (stepErr) return reject(stepErr);
          resolve(token);
        });
      });
    });
  }

  /**
   * Parse XML string to JavaScript object using xml2js.
   */
  private parseXml(xmlString: string): Promise<any> {
    return new Promise((resolve, reject) => {
      parseString(xmlString, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  // -------------------------------
  // SOAP Envelope Builders
  // -------------------------------
  private buildCreateShellEnvelope(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"
            xmlns:ws="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">
  <s:Header>
    <wsa:Action>http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Create</wsa:Action>
    <wsa:To>${this.useSSL ? 'https' : 'http'}://${this.host}:${this.port}${this.path}</wsa:To>
    <wsa:MessageID>urn:uuid:${this.generateUuid()}</wsa:MessageID>
    <wsman:ResourceURI s:mustUnderstand="true">http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd</wsman:ResourceURI>
    <wsa:ReplyTo>
      <wsa:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address>
    </wsa:ReplyTo>
    <wsman:OperationTimeout>PT60S</wsman:OperationTimeout>
  </s:Header>
  <s:Body>
    <ws:Shell>
      <ws:InputStreams>stdin</ws:InputStreams>
      <ws:OutputStreams>stdout stderr</ws:OutputStreams>
    </ws:Shell>
  </s:Body>
</s:Envelope>`;
  }

  private buildExecuteCommandEnvelope(shellId: string, command: string): string {
    return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"
            xmlns:ws="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">
  <s:Header>
    <wsa:Action>http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command</wsa:Action>
    <wsa:To>${this.useSSL ? 'https' : 'http'}://${this.host}:${this.port}${this.path}</wsa:To>
    <wsa:MessageID>urn:uuid:${this.generateUuid()}</wsa:MessageID>
    <wsa:ReplyTo>
      <wsa:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address>
    </wsa:ReplyTo>
    <wsman:ResourceURI>http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd</wsman:ResourceURI>
    <wsman:OperationTimeout>PT60S</wsman:OperationTimeout>
    <wsman:SelectorSet>
      <wsman:Selector Name="ShellId">${shellId}</wsman:Selector>
    </wsman:SelectorSet>
  </s:Header>
  <s:Body>
    <ws:CommandLine>
      <ws:Command>${this.escapeXml(command)}</ws:Command>
    </ws:CommandLine>
  </s:Body>
</s:Envelope>`;
  }

  private buildReceiveEnvelope(shellId: string, commandId: string): string {
    return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"
            xmlns:ws="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">
  <s:Header>
    <wsa:Action>http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive</wsa:Action>
    <wsa:To>${this.useSSL ? 'https' : 'http'}://${this.host}:${this.port}${this.path}</wsa:To>
    <wsa:MessageID>urn:uuid:${this.generateUuid()}</wsa:MessageID>
    <wsa:ReplyTo>
      <wsa:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address>
    </wsa:ReplyTo>
    <wsman:ResourceURI>http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd</wsman:ResourceURI>
    <wsman:OperationTimeout>PT60S</wsman:OperationTimeout>
    <wsman:SelectorSet>
      <wsman:Selector Name="ShellId">${shellId}</wsman:Selector>
    </wsman:SelectorSet>
  </s:Header>
  <s:Body>
    <ws:Receive>
      <ws:DesiredStream>stdout stderr</ws:DesiredStream>
      <ws:DesiredStream CommandId="${commandId}">stdout stderr</ws:DesiredStream>
    </ws:Receive>
  </s:Body>
</s:Envelope>`;
  }

  private buildDeleteShellEnvelope(shellId: string): string {
    return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"
            xmlns:ws="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">
  <s:Header>
    <wsa:Action>http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Delete</wsa:Action>
    <wsa:To>${this.useSSL ? 'https' : 'http'}://${this.host}:${this.port}${this.path}</wsa:To>
    <wsa:MessageID>urn:uuid:${this.generateUuid()}</wsa:MessageID>
    <wsa:ReplyTo>
      <wsa:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address>
    </wsa:ReplyTo>
    <wsman:ResourceURI>http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd</wsman:ResourceURI>
    <wsman:OperationTimeout>PT60S</wsman:OperationTimeout>
    <wsman:SelectorSet>
      <wsman:Selector Name="ShellId">${shellId}</wsman:Selector>
    </wsman:SelectorSet>
  </s:Header>
  <s:Body />
</s:Envelope>`;
  }

  // -------------------------------
  // SOAP Response Parsing
  // -------------------------------
  private extractShellId(response: any): string | null {
    // Typical path: Envelope.Body[0].CreateResponse[0].Shell[0].ShellId[0]
    try {
      return response['s:Envelope']['s:Body'][0]['rsp:Shell'][0]['rsp:ShellId'][0];
    } catch (e) {
      return null;
    }
  }

  private extractCommandId(response: any): string | null {
    // Typical path: Envelope.Body[0].CommandResponse[0].CommandId[0]
    // The XML namespace might appear as "rsp" or "w" or something else,
    // depending on the WinRM server version. Adjust if needed.
    try {
      return response['s:Envelope']['s:Body'][0]['rsp:CommandResponse'][0]['rsp:CommandId'][0];
    } catch (e) {
      return null;
    }
  }

  private extractCommandOutput(response: any): string {
    // Typical path for stdout:
    // Envelope.Body[0].ReceiveResponse[0].Stream[0]['_']
    // Also note there's a "CommandState" element that can contain the exit code
    // e.g., Envelope.Body[0].ReceiveResponse[0].CommandState[0]['$'].State
    // This code merges stdout + stderr if present.
    try {
      const streams = response['s:Envelope']['s:Body'][0]['rsp:ReceiveResponse'][0]['rsp:Stream'] || [];
      let output = '';
      for (const stream of streams) {
        if (stream && stream['_']) {
          // The stream is base64 encoded. Decoding it:
          const decoded = Buffer.from(stream['_'], 'base64').toString('utf8');
          output += decoded;
        }
      }
      return output.trim();
    } catch (e) {
      return '';
    }
  }

  // -------------------------------
  // Helpers
  // -------------------------------
  private generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private escapeXml(unsafe: string): string {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
