import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

/**
 * Autenticação NÃO implementada neste desafio (decisão documentada no
 * ARCHITECTURE.md, seção "Autenticação"). Este é o ponto de extensão.
 *
 * Desenho previsto: Keycloak como IdP, um client OIDC por provedor de jogos
 * com client_credentials. O guard valida o JWT (assinatura via JWKS, issuer,
 * audience, expiração) e uma implementação de ProviderIdentityPort extrai o
 * providerId do token. O caso de uso então exige que o providerId do payload
 * seja o mesmo do token.
 */
export interface ProviderIdentity {
  /** undefined = qualquer provedor (modo sem autenticação). */
  providerId?: string;
}

export interface ProviderIdentityPort {
  resolve(request: Request): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

/** Implementação no-op: aceita toda requisição sem identidade. */
export class AllowAllProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity> {
    return {};
  }
}

const PUBLIC_ROUTE = 'publicRoute';
/** Marca rotas que nunca exigem autenticação (health checks, métricas). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<Request & { provider?: ProviderIdentity }>();
    const identity = await this.identity.resolve(request);
    if (!identity) return false;
    request.provider = identity;
    return true;
  }
}
