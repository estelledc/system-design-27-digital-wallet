import {
  parseAuditInput,
  parseId,
  parsePageLimit,
  parsePostInput,
  parseReversalInput,
  parseStateInput,
  parseStatementInput,
  parseTransferInput,
  parseWalletInput
} from './contracts.js';

export class WalletService {
  constructor(repository) {
    this.repository = repository;
  }

  createWallet(raw, options) {
    return this.repository.createWallet(parseWalletInput(raw), options);
  }

  transitionWallet(walletId, action, raw, options) {
    return this.repository.transitionWallet(parseStateInput(raw, walletId, action), options);
  }

  prepareTransfer(raw, options) {
    return this.repository.prepareTransfer(parseTransferInput(raw), options);
  }

  postTransfer(transferId, raw, options) {
    return this.repository.postTransfer(parsePostInput(raw, transferId), options);
  }

  reverseTransfer(transferId, raw, options) {
    return this.repository.reverseTransfer(parseReversalInput(raw, transferId), options);
  }

  publishStatement(raw, options) {
    return this.repository.publishStatement(parseStatementInput(raw), options);
  }

  getStatementPage(statementId, cursor, limit) {
    return this.repository.getStatementPage(
      parseId(statementId, 'statementId'),
      cursor,
      parsePageLimit(limit)
    );
  }

  runAudit(raw, options) {
    return this.repository.runAudit(parseAuditInput(raw), options);
  }

  getWalletEvidence(walletId) {
    return this.repository.getWalletEvidence(parseId(walletId, 'walletId'));
  }

  getState() {
    return this.repository.getState();
  }

  health() {
    return this.repository.health();
  }
}
