import type { TSESTree } from '@typescript-eslint/utils';

import { AST_NODE_TYPES } from '@typescript-eslint/utils';
import * as tsutils from 'ts-api-utils';
import * as ts from 'typescript';

import {
  createRule,
  getConstraintInfo,
  getParserServices,
  isStrongPrecedenceNode,
} from '../util';

export type MessageIds =
  | 'comparingNullableToFalse'
  | 'comparingNullableToTrueDirect'
  | 'comparingNullableToTrueNegated'
  | 'direct'
  | 'negated'
  | 'noStrictNullCheck';

export type Options = [
  {
    allowComparingNullableBooleansToFalse?: boolean;
    allowComparingNullableBooleansToTrue?: boolean;
    allowRuleToRunWithoutStrictNullChecksIKnowWhatIAmDoing?: boolean;
  },
];

interface BooleanComparison {
  expression: TSESTree.Expression | TSESTree.PrivateIdentifier;
  literalBooleanInComparison: boolean;
  negated: boolean;
}

interface BooleanComparisonWithTypeInformation extends BooleanComparison {
  expressionIsNullableBoolean: boolean;
}

export default createRule<Options, MessageIds>({
  name: 'no-unnecessary-boolean-literal-compare',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow unnecessary equality comparisons against boolean literals',
      recommended: 'strict',
      requiresTypeChecking: true,
    },
    fixable: 'code',
    messages: {
      comparingNullableToFalse:
        'This expression unnecessarily compares a nullable boolean value to false instead of using the ?? operator to provide a default.',
      comparingNullableToTrueDirect:
        'This expression unnecessarily compares a nullable boolean value to true instead of using it directly.',
      comparingNullableToTrueNegated:
        'This expression unnecessarily compares a nullable boolean value to true instead of negating it.',
      direct:
        'This expression unnecessarily compares a boolean value to a boolean instead of using it directly.',
      negated:
        'This expression unnecessarily compares a boolean value to a boolean instead of negating it.',
      noStrictNullCheck:
        'This rule requires the `strictNullChecks` compiler option to be turned on to function correctly.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowComparingNullableBooleansToFalse: {
            type: 'boolean',
            description:
              'Whether to allow comparisons between nullable boolean variables and `false`.',
          },
          allowComparingNullableBooleansToTrue: {
            type: 'boolean',
            description:
              'Whether to allow comparisons between nullable boolean variables and `true`.',
          },
          allowRuleToRunWithoutStrictNullChecksIKnowWhatIAmDoing: {
            type: 'boolean',
            description:
              'Unless this is set to `true`, the rule will error on every file whose `tsconfig.json` does _not_ have the `strictNullChecks` compiler option (or `strict`) set to `true`.',
          },
        },
      },
    ],
  },
  defaultOptions: [
    {
      allowComparingNullableBooleansToFalse: true,
      allowComparingNullableBooleansToTrue: true,
      allowRuleToRunWithoutStrictNullChecksIKnowWhatIAmDoing: false,
    },
  ],
  create(context, [options]) {
    const services = getParserServices(context);
    const checker = services.program.getTypeChecker();
    const compilerOptions = services.program.getCompilerOptions();

    const isStrictNullChecks = tsutils.isStrictCompilerOptionEnabled(
      compilerOptions,
      'strictNullChecks',
    );

    if (
      !isStrictNullChecks &&
      options.allowRuleToRunWithoutStrictNullChecksIKnowWhatIAmDoing !== true
    ) {
      context.report({
        loc: {
          start: { column: 0, line: 0 },
          end: { column: 0, line: 0 },
        },
        messageId: 'noStrictNullCheck',
      });
    }

    function getBooleanComparison(
      node: TSESTree.BinaryExpression,
    ): BooleanComparisonWithTypeInformation | undefined {
      const comparison = deconstructComparison(node);
      if (!comparison) {
        return undefined;
      }

      const { constraintType, isTypeParameter } = getConstraintInfo(
        checker,
        services.getTypeAtLocation(comparison.expression),
      );

      if (isTypeParameter && constraintType == null) {
        return undefined;
      }

      if (isBooleanType(constraintType)) {
        return {
          ...comparison,
          expressionIsNullableBoolean: false,
        };
      }

      if (isNullableBoolean(constraintType)) {
        return {
          ...comparison,
          expressionIsNullableBoolean: true,
        };
      }

      return undefined;
    }

    function isBooleanType(expressionType: ts.Type): boolean {
      return tsutils.isTypeFlagSet(
        expressionType,
        ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral,
      );
    }

    /**
     * checks if the expressionType is a union that
     *   1) contains at least one nullish type (null or undefined)
     *   2) contains at least once boolean type (true or false or boolean)
     *   3) does not contain any types besides nullish and boolean types
     */
    function isNullableBoolean(expressionType: ts.Type): boolean {
      if (!expressionType.isUnion()) {
        return false;
      }

      const { types } = expressionType;

      const nonNullishTypes = types.filter(
        type =>
          !tsutils.isTypeFlagSet(
            type,
            ts.TypeFlags.Undefined | ts.TypeFlags.Null,
          ),
      );

      const hasNonNullishType = nonNullishTypes.length > 0;
      if (!hasNonNullishType) {
        return false;
      }

      const hasNullableType = nonNullishTypes.length < types.length;
      if (!hasNullableType) {
        return false;
      }

      const allNonNullishTypesAreBoolean = nonNullishTypes.every(isBooleanType);
      if (!allNonNullishTypesAreBoolean) {
        return false;
      }

      return true;
    }

    function deconstructComparison(
      node: TSESTree.BinaryExpression,
    ): BooleanComparison | undefined {
      const comparisonType = getEqualsKind(node.operator);
      if (!comparisonType) {
        return undefined;
      }

      for (const [against, expression] of [
        [node.right, node.left],
        [node.left, node.right],
      ]) {
        if (
          against.type !== AST_NODE_TYPES.Literal ||
          typeof against.value !== 'boolean'
        ) {
          continue;
        }

        const { value: literalBooleanInComparison } = against;
        const negated = !comparisonType.isPositive;

        return {
          expression,
          literalBooleanInComparison,
          negated,
        };
      }

      return undefined;
    }

    function nodeIsUnaryNegation(node: TSESTree.Node): boolean {
      return (
        node.type === AST_NODE_TYPES.UnaryExpression &&
        node.prefix &&
        node.operator === '!'
      );
    }

    return {
      BinaryExpression(node): void {
        const comparison = getBooleanComparison(node);
        if (comparison == null) {
          return;
        }

        if (comparison.expressionIsNullableBoolean) {
          if (
            comparison.literalBooleanInComparison &&
            options.allowComparingNullableBooleansToTrue
          ) {
            return;
          }
          if (
            !comparison.literalBooleanInComparison &&
            options.allowComparingNullableBooleansToFalse
          ) {
            return;
          }
        }

        context.report({
          node,
          messageId: comparison.expressionIsNullableBoolean
            ? comparison.literalBooleanInComparison
              ? comparison.negated
                ? 'comparingNullableToTrueNegated'
                : 'comparingNullableToTrueDirect'
              : 'comparingNullableToFalse'
            : comparison.negated
              ? 'negated'
              : 'direct',
          *fix(fixer) {
            // 1. isUnaryNegation - parent negation
            // 2. literalBooleanInComparison - is compared to literal boolean
            // 3. negated - is expression negated

            const isUnaryNegation = nodeIsUnaryNegation(node.parent);

            const shouldNegate =
              comparison.negated !== comparison.literalBooleanInComparison;

            const mutatedNode = isUnaryNegation ? node.parent : node;

            yield fixer.replaceText(
              mutatedNode,
              context.sourceCode.getText(comparison.expression),
            );

            // if `isUnaryNegation === literalBooleanInComparison === !negated` is true - negate the expression
            if (shouldNegate === isUnaryNegation) {
              yield fixer.insertTextBefore(mutatedNode, '!');

              // if the expression `exp` is not a strong precedence node, wrap it in parentheses
              if (!isStrongPrecedenceNode(comparison.expression)) {
                yield fixer.insertTextBefore(mutatedNode, '(');
                yield fixer.insertTextAfter(mutatedNode, ')');
              }
            }

            // if the expression `exp` is nullable, and we're not comparing to `true`, insert `?? true`
            if (
              comparison.expressionIsNullableBoolean &&
              !comparison.literalBooleanInComparison
            ) {
              // provide the default `true`
              yield fixer.insertTextBefore(mutatedNode, '(');
              yield fixer.insertTextAfter(mutatedNode, ' ?? true)');
            }
          },
        });
      },
    };
  },
});

interface EqualsKind {
  isPositive: boolean;
  isStrict: boolean;
}

function getEqualsKind(operator: string): EqualsKind | undefined {
  switch (operator) {
    case '!=':
      return {
        isPositive: false,
        isStrict: false,
      };

    case '!==':
      return {
        isPositive: false,
        isStrict: true,
      };

    case '==':
      return {
        isPositive: true,
        isStrict: false,
      };

    case '===':
      return {
        isPositive: true,
        isStrict: true,
      };

    default:
      return undefined;
  }
}
