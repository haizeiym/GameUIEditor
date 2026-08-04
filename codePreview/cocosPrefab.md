```ts
import { _decorator, Node } from "cc";
import { BaseComponent, BindUI } from "lsscript";
const { ccclass } = _decorator;

@ccclass("FileName")
class FileName extends BaseComponent {
    private _bindUI: BindUI;

    public setInit(args: {parent:Node}): void {
        this._setInit(args.parent);
        
    }

    protected _initView(): void {
        this._bindUI = this._getUI(this.node);
    }

    protected _initEvent(): void {
        if(this._bindUI.Btn("BtnClose")){
            this._addClick(this._bindUI.Btn("BtnClose"), this.NodeDestroy);
        }
    }

    protected _destroyBefore(): void {

    }
}

```